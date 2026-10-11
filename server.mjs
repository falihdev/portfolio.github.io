import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Micro-service de conversion Office → images PNG.
 *
 * Reçoit un document legacy (.doc, .ppt, .xls, .xlsb…) et le convertit en PDF
 * avec LibreOffice headless, puis rastérise chaque page en PNG avec poppler
 * (`pdftoppm`). L'app Next.js (Vercel) appelle ce service puis envoie les
 * images à Gemini.
 *
 * Le document peut arriver en plusieurs morceaux (`/chunk`) pour contourner la
 * limite de 4,5 Mo par requête de Vercel.
 *
 * Variables d'environnement :
 *   PORT                port d'écoute (défaut 8080)
 *   CONVERT_TOKEN       jeton partagé exigé dans `Authorization: Bearer …`
 *   MAX_BYTES           taille max d'un fichier source (défaut 25 Mo)
 *   MAX_PAGES           nombre max de pages rastérisées (défaut 40)
 *   RENDER_DPI          résolution de rastérisation (défaut 130)
 *   CONVERT_TIMEOUT_MS  délai max par étape de conversion (défaut 60000)
 *   CHUNK_TTL_MS        âge au-delà duquel une session de chunks est purgée
 *   MAX_CHUNKS          nombre max de morceaux par fichier (défaut 64)
 */

const PORT = Number(process.env.PORT || 8080)
const TOKEN = (process.env.CONVERT_TOKEN || "").trim()
const MAX_BYTES = Number(process.env.MAX_BYTES || 25_000_000)
const MAX_PAGES = Number(process.env.MAX_PAGES || 40)
const RENDER_DPI = Number(process.env.RENDER_DPI || 130)
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 60_000)
const CHUNK_TTL_MS = Number(process.env.CHUNK_TTL_MS || 30 * 60_000)
const MAX_CHUNKS = Number(process.env.MAX_CHUNKS || 64)
const MAX_JSON_BYTES = Math.ceil((MAX_BYTES * 4) / 3) + 2_000_000
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/

/**
 * LibreOffice ne peut pas tourner en parallèle sur un même profil : on
 * sérialise les conversions pour rester fiable sous charge.
 */
let queue = Promise.resolve()
function enqueue(task) {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        reject(httpError(413, "payload too large"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(httpError(504, `${command} timed out`))
    }, timeoutMs)

    child.stderr?.on("data", (data) => {
      stderr += data.toString()
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(httpError(500, error.message))
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(httpError(500, `${command} exited ${code}: ${stderr.slice(0, 300)}`))
    })
  })
}

function pageNumber(fileName) {
  const match = fileName.match(/-(\d+)\.png$/i)
  return match ? Number(match[1]) : 0
}

/** Convertit un document (octets bruts) en une liste d'images PNG (base64). */
async function convertDocument(name, bytes) {
  if (!bytes.length) throw httpError(400, "empty file")
  if (bytes.length > MAX_BYTES) throw httpError(413, "file too large")

  const dir = await mkdtemp(path.join(tmpdir(), "office-convert-"))
  const profile = path.join(dir, "profile")
  const ext = (path.extname(name).replace(/[^a-z0-9.]/gi, "") || ".bin").toLowerCase()
  const inputPath = path.join(dir, `input${ext}`)
  const pdfPath = path.join(dir, "input.pdf")

  try {
    await writeFile(inputPath, bytes)

    await runProcess(
      "soffice",
      [
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nologo",
        `-env:UserInstallation=file://${profile}`,
        "--convert-to",
        "pdf",
        "--outdir",
        dir,
        inputPath,
      ],
      CONVERT_TIMEOUT_MS,
    )

    // LibreOffice peut sortir en 0 sans produire de PDF (format illisible).
    await readFile(pdfPath).catch(() => {
      throw httpError(422, "conversion failed")
    })

    await runProcess(
      "pdftoppm",
      ["-png", "-r", String(RENDER_DPI), "-f", "1", "-l", String(MAX_PAGES), pdfPath, path.join(dir, "page")],
      CONVERT_TIMEOUT_MS,
    )

    const pages = (await readdir(dir))
      .filter((entry) => /^page-\d+\.png$/i.test(entry))
      .sort((a, b) => pageNumber(a) - pageNumber(b))
    if (!pages.length) throw httpError(422, "no page rendered")

    const base = path.basename(name, path.extname(name)) || "document"
    const images = []
    for (const page of pages) {
      const buffer = await readFile(path.join(dir, page))
      images.push({
        name: `${base}-page${pageNumber(page)}.png`,
        mimeType: "image/png",
        dataBase64: buffer.toString("base64"),
      })
    }
    return images
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function sessionDir(sessionId) {
  return path.join(tmpdir(), `office-chunk-${sessionId}`)
}

/** Reçoit un morceau de document ; convertit quand le dernier arrive. */
async function handleChunk(body) {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : ""
  const name = typeof body.name === "string" ? body.name.slice(0, 255) : ""
  const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : ""
  const chunkIndex = Number(body.chunkIndex)
  const chunkCount = Number(body.chunkCount)

  if (
    !SESSION_ID_RE.test(sessionId) ||
    !name ||
    !Number.isInteger(chunkIndex) ||
    !Number.isInteger(chunkCount) ||
    chunkIndex < 0 ||
    chunkCount < 1 ||
    chunkCount > MAX_CHUNKS ||
    chunkIndex >= chunkCount
  ) {
    throw httpError(400, "bad-request")
  }

  const part = Buffer.from(dataBase64, "base64")
  if (!part.length) throw httpError(400, "empty chunk")

  const dir = sessionDir(sessionId)
  await mkdir(dir, { recursive: true }).catch(() => undefined)
  await writeFile(path.join(dir, `${chunkIndex}.part`), part)

  if (chunkIndex < chunkCount - 1) {
    return { pending: true, received: chunkIndex + 1, total: chunkCount }
  }

  // Dernier morceau : on rassemble dans l'ordre et on convertit.
  const parts = []
  for (let index = 0; index < chunkCount; index += 1) {
    const partPath = path.join(dir, `${index}.part`)
    const buffer = await readFile(partPath).catch(() => {
      throw httpError(409, `missing chunk ${index}`)
    })
    parts.push(buffer)
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)

  const doc = Buffer.concat(parts)
  const images = await enqueue(() => convertDocument(name, doc))
  return { images }
}

/** Purge périodique des sessions de chunks abandonnées. */
async function pruneStaleChunks() {
  try {
    const root = tmpdir()
    const entries = await readdir(root)
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.startsWith("office-chunk-")) continue
      const full = path.join(root, entry)
      const info = await stat(full).catch(() => null)
      if (info && now - info.mtimeMs > CHUNK_TTL_MS) {
        await rm(full, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  } catch {
    // Meilleur effort.
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost")

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true })
    return
  }

  if (request.method !== "POST" || (url.pathname !== "/convert" && url.pathname !== "/chunk")) {
    sendJson(response, 404, { error: "not-found" })
    return
  }

  if (TOKEN) {
    const auth = request.headers.authorization || ""
    if (auth !== `Bearer ${TOKEN}`) {
      sendJson(response, 401, { error: "unauthorized" })
      return
    }
  }

  try {
    const raw = await readBody(request)
    const body = JSON.parse(raw || "{}")

    if (url.pathname === "/chunk") {
      const result = await handleChunk(body)
      sendJson(response, 200, result)
      return
    }

    const name = typeof body.name === "string" ? body.name.slice(0, 255) : ""
    const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : ""
    if (!name || !dataBase64) {
      sendJson(response, 400, { error: "bad-request" })
      return
    }
    const images = await enqueue(() => convertDocument(name, Buffer.from(dataBase64, "base64")))
    sendJson(response, 200, { images })
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : 500
    if (!response.headersSent) {
      sendJson(response, status, { error: error?.message || "conversion-failed" })
    }
  }
})

server.listen(PORT, () => {
  console.log(`[office-convert] listening on :${PORT} (token ${TOKEN ? "required" : "disabled"})`)
})

setInterval(pruneStaleChunks, 10 * 60_000).unref()
