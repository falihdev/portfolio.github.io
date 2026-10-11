import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Micro-service de conversion Office → images PNG (asynchrone).
 *
 * Reçoit un document legacy (.doc, .ppt, .xls, .xlsb…) en morceaux, le
 * convertit en PDF avec LibreOffice headless puis rastérise chaque page en PNG
 * (poppler `pdftoppm`). Comme une grosse présentation peut dépasser 60 s, la
 * conversion tourne en tâche de fond : l'app reçoit un `jobId` puis récupère
 * les pages une fois prêtes.
 *
 * Variables d'environnement :
 *   PORT                port d'écoute (défaut 8080)
 *   CONVERT_TOKEN       jeton partagé exigé dans `Authorization: Bearer …`
 *   MAX_BYTES           taille max d'un fichier source (défaut 25 Mo)
 *   MAX_PAGES           nombre max de pages rastérisées (défaut 60)
 *   RENDER_DPI          résolution de rastérisation (défaut 120)
 *   CONVERT_TIMEOUT_MS  délai max par étape de conversion (défaut 180000)
 *   MAX_CHUNKS          nombre max de morceaux par fichier (défaut 64)
 *   TTL_MS              âge au-delà duquel jobs/morceaux sont purgés
 */

const PORT = Number(process.env.PORT || 8080)
const TOKEN = (process.env.CONVERT_TOKEN || "").trim()
const MAX_BYTES = Number(process.env.MAX_BYTES || 25_000_000)
const MAX_PAGES = Number(process.env.MAX_PAGES || 60)
const RENDER_DPI = Number(process.env.RENDER_DPI || 120)
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 180_000)
const MAX_CHUNKS = Number(process.env.MAX_CHUNKS || 64)
const TTL_MS = Number(process.env.TTL_MS || 30 * 60_000)
const MAX_JSON_BYTES = Math.ceil((MAX_BYTES * 4) / 3) + 2_000_000
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/
const JOB_ID_RE = /^[a-f0-9]{16,64}$/i

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

function safeBaseName(name) {
  return path.basename(name || "document", path.extname(name || "")) || "document"
}

/**
 * Convertit un document (octets bruts) en PNG dans `<workDir>/pages`.
 * Renvoie les noms de fichiers triés + les chemins à nettoyer.
 */
async function renderPages(name, bytes, workDir) {
  if (!bytes.length) throw httpError(400, "empty file")
  if (bytes.length > MAX_BYTES) throw httpError(413, "file too large")

  const ext = (path.extname(name).replace(/[^a-z0-9.]/gi, "") || ".bin").toLowerCase()
  const inputPath = path.join(workDir, `input${ext}`)
  const pdfPath = path.join(workDir, "input.pdf")
  const profile = path.join(workDir, "profile")
  const pagesDir = path.join(workDir, "pages")
  await mkdir(pagesDir, { recursive: true })
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
      workDir,
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
    ["-png", "-r", String(RENDER_DPI), "-f", "1", "-l", String(MAX_PAGES), pdfPath, path.join(pagesDir, "page")],
    CONVERT_TIMEOUT_MS,
  )

  const pages = (await readdir(pagesDir))
    .filter((entry) => /^page-\d+\.png$/i.test(entry))
    .sort((a, b) => pageNumber(a) - pageNumber(b))
  if (!pages.length) throw httpError(422, "no page rendered")

  return { pages, pagesDir, inputPath, pdfPath, profile }
}

/** Conversion synchrone (utilisée pour les tests / petits fichiers). */
async function convertSync(name, bytes) {
  const dir = await mkdtemp(path.join(tmpdir(), "office-convert-"))
  try {
    const { pages, pagesDir } = await renderPages(name, bytes, dir)
    const base = safeBaseName(name)
    const images = []
    for (const page of pages) {
      const buffer = await readFile(path.join(pagesDir, page))
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

function chunkDir(sessionId) {
  return path.join(tmpdir(), `office-chunk-${sessionId}`)
}

function jobDir(jobId) {
  return path.join(tmpdir(), `office-job-${jobId}`)
}

async function writeStatus(dir, status) {
  const tmp = path.join(dir, "status.json.tmp")
  await writeFile(tmp, JSON.stringify(status))
  await rename(tmp, path.join(dir, "status.json")).catch(async () => {
    await writeFile(path.join(dir, "status.json"), JSON.stringify(status))
  })
}

async function readStatus(jobId) {
  const raw = await readFile(path.join(jobDir(jobId), "status.json"), "utf8").catch(() => null)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Travail de fond : convertit puis publie les pages dans `status.json`. */
async function runJob(jobId, name, bytes) {
  const dir = jobDir(jobId)
  try {
    const { pages, pagesDir, inputPath, pdfPath, profile } = await renderPages(name, bytes, dir)
    const base = safeBaseName(name)
    const infos = pages.map((page) => ({
      file: page,
      name: `${base}-page${pageNumber(page)}.png`,
      mimeType: "image/png",
    }))
    await writeStatus(dir, { status: "done", pages: infos })
    // Le PDF et le profil ne servent plus : on libère l'espace.
    await Promise.all([
      rm(inputPath, { force: true }),
      rm(pdfPath, { force: true }),
      rm(profile, { recursive: true, force: true }),
      rm(path.join(dir, "input.pdf"), { force: true }),
    ])
    void pagesDir
  } catch (error) {
    const code = typeof error?.status === "number" ? error.status : 500
    await writeStatus(dir, { status: "error", error: code }).catch(() => undefined)
  }
}

/** Reçoit un morceau ; démarre la conversion en tâche de fond au dernier. */
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

  const dir = chunkDir(sessionId)
  await mkdir(dir, { recursive: true }).catch(() => undefined)
  await writeFile(path.join(dir, `${chunkIndex}.part`), part)

  if (chunkIndex < chunkCount - 1) {
    return { pending: true, received: chunkIndex + 1, total: chunkCount }
  }

  const parts = []
  for (let index = 0; index < chunkCount; index += 1) {
    const buffer = await readFile(path.join(dir, `${index}.part`)).catch(() => {
      throw httpError(409, `missing chunk ${index}`)
    })
    parts.push(buffer)
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)

  const jobId = randomBytes(12).toString("hex")
  const target = jobDir(jobId)
  await mkdir(target, { recursive: true })
  await writeStatus(target, { status: "processing", pages: [] })
  enqueue(() => runJob(jobId, name, Buffer.concat(parts))).catch(() => undefined)

  return { jobId }
}

async function handleJobStatus(jobId) {
  const status = await readStatus(jobId)
  if (!status) throw httpError(404, "job not found")
  return {
    status: status.status,
    pageCount: Array.isArray(status.pages) ? status.pages.length : 0,
    error: status.error,
  }
}

async function handleJobPage(jobId, index) {
  const status = await readStatus(jobId)
  if (!status) throw httpError(404, "job not found")
  if (status.status !== "done") throw httpError(409, "job not ready")
  const page = Array.isArray(status.pages) ? status.pages[index] : null
  if (!page) throw httpError(404, "page not found")
  const buffer = await readFile(path.join(jobDir(jobId), "pages", page.file))
  return { name: page.name, mimeType: page.mimeType, dataBase64: buffer.toString("base64") }
}

/** Purge périodique des jobs et morceaux abandonnés. */
async function pruneStale() {
  try {
    const root = tmpdir()
    const now = Date.now()
    for (const entry of await readdir(root)) {
      if (!entry.startsWith("office-chunk-") && !entry.startsWith("office-job-")) continue
      const full = path.join(root, entry)
      const info = await stat(full).catch(() => null)
      if (info && now - info.mtimeMs > TTL_MS) {
        await rm(full, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  } catch {
    // Meilleur effort.
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost")
  const { pathname } = url

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { ok: true })
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
    // GET /jobs/:id  |  GET /jobs/:id/pages/:index
    if (request.method === "GET" && pathname.startsWith("/jobs/")) {
      const rest = pathname.slice("/jobs/".length).split("/")
      const jobId = rest[0]
      if (!JOB_ID_RE.test(jobId)) {
        sendJson(response, 400, { error: "bad-request" })
        return
      }
      if (rest.length === 1) {
        sendJson(response, 200, await handleJobStatus(jobId))
        return
      }
      if (rest.length === 3 && rest[1] === "pages") {
        const index = Number(rest[2])
        if (!Number.isInteger(index) || index < 0) {
          sendJson(response, 400, { error: "bad-request" })
          return
        }
        sendJson(response, 200, await handleJobPage(jobId, index))
        return
      }
      sendJson(response, 404, { error: "not-found" })
      return
    }

    if (request.method !== "POST" || (pathname !== "/convert" && pathname !== "/chunk")) {
      sendJson(response, 404, { error: "not-found" })
      return
    }

    const raw = await readBody(request)
    const body = JSON.parse(raw || "{}")

    if (pathname === "/chunk") {
      sendJson(response, 200, await handleChunk(body))
      return
    }

    const name = typeof body.name === "string" ? body.name.slice(0, 255) : ""
    const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : ""
    if (!name || !dataBase64) {
      sendJson(response, 400, { error: "bad-request" })
      return
    }
    const images = await enqueue(() => convertSync(name, Buffer.from(dataBase64, "base64")))
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

setInterval(pruneStale, 10 * 60_000).unref()
