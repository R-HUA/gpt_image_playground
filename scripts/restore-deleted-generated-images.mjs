#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function parseArgs(argv) {
  const args = {
    dataDir: process.env.GIP_DATA_DIR || join(process.cwd(), 'data'),
    apply: false,
    userId: null,
    taskId: '',
    since: 0,
    limit: 0,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index] || ''
    if (arg === '--apply') args.apply = true
    else if (arg === '--data-dir') args.dataDir = next()
    else if (arg === '--user-id') args.userId = Number.parseInt(next(), 10)
    else if (arg === '--task-id') args.taskId = next()
    else if (arg === '--since') args.since = Date.parse(next()) || Number.parseInt(argv[index], 10) || 0
    else if (arg === '--limit') args.limit = Math.max(0, Number.parseInt(next(), 10) || 0)
    else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (args.userId != null && !Number.isFinite(args.userId)) throw new Error('--user-id must be a number')
  return args
}

function printHelp() {
  console.log(`Restore archived generated images that were deleted while their tasks still exist.

Usage:
  node scripts/restore-deleted-generated-images.mjs [options]

Options:
  --apply                 Actually write files and image rows. Without this, dry-run only.
  --data-dir <path>       Data directory containing app.sqlite. Default: $GIP_DATA_DIR or ./data.
  --user-id <id>          Restore only one user.
  --task-id <id>          Restore only one task.
  --since <date|ms>       Restore rows deleted after this time.
  --limit <n>             Process at most n archive rows.
`)
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value) return ''
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.includes('../') || normalized === '..') return ''
  return normalized
}

function taskReferencesImage(task, imageId) {
  return Array.isArray(task?.outputImages) && task.outputImages.includes(imageId)
}

function buildQuery(args) {
  const where = []
  const params = []
  if (args.userId != null) {
    where.push('user_id = ?')
    params.push(args.userId)
  }
  if (args.taskId) {
    where.push('task_id = ?')
    params.push(args.taskId)
  }
  if (args.since) {
    where.push('deleted_at >= ?')
    params.push(args.since)
  }
  const sql = `
    SELECT *
    FROM deleted_generated_images
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY deleted_at ASC, id ASC
    ${args.limit ? `LIMIT ${args.limit}` : ''}
  `
  return { sql, params }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = resolve(args.dataDir)
  const dbPath = join(dataDir, 'app.sqlite')
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`)

  const db = new DatabaseSync(dbPath)
  const { sql, params } = buildQuery(args)
  const rows = db.prepare(sql).all(...params)
  const stats = {
    scanned: 0,
    restored: 0,
    skippedExisting: 0,
    skippedNoActiveTask: 0,
    skippedNotReferenced: 0,
    skippedMissingArchive: 0,
    skippedUnsafePath: 0,
  }

  const restoreOne = (row) => {
    stats.scanned += 1
    const existing = db.prepare('SELECT 1 FROM images WHERE user_id = ? AND id = ?').get(row.user_id, row.image_id)
    if (existing) {
      stats.skippedExisting += 1
      return
    }

    const taskRow = db.prepare('SELECT json FROM tasks WHERE user_id = ? AND id = ?').get(row.user_id, row.task_id)
    if (!taskRow) {
      stats.skippedNoActiveTask += 1
      return
    }
    const task = parseJson(taskRow.json, null)
    if (!taskReferencesImage(task, row.image_id)) {
      stats.skippedNotReferenced += 1
      return
    }

    const archivePath = safeRelativePath(row.archived_file_path)
    const originalPath = safeRelativePath(row.original_file_path)
    if (!archivePath || !originalPath) {
      stats.skippedUnsafePath += 1
      return
    }

    const archiveAbsolute = resolve(dataDir, archivePath)
    const originalAbsolute = resolve(dataDir, originalPath)
    if (!archiveAbsolute.startsWith(dataDir) || !originalAbsolute.startsWith(dataDir)) {
      stats.skippedUnsafePath += 1
      return
    }
    if (!existsSync(archiveAbsolute)) {
      stats.skippedMissingArchive += 1
      return
    }

    console.log(`${args.apply ? 'restore' : 'would restore'} user=${row.user_id} task=${row.task_id} image=${row.image_id}`)
    if (!args.apply) return

    mkdirSync(dirname(originalAbsolute), { recursive: true })
    if (!existsSync(originalAbsolute)) copyFileSync(archiveAbsolute, originalAbsolute)
    db.prepare(`
      INSERT OR IGNORE INTO images (user_id, id, mime, file_path, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.user_id,
      row.image_id,
      row.mime,
      originalPath,
      row.image_metadata_json,
      row.created_at,
      Date.now(),
    )
    stats.restored += 1
  }

  if (args.apply) db.exec('BEGIN')
  try {
    for (const row of rows) restoreOne(row)
    if (args.apply) db.exec('COMMIT')
  } catch (err) {
    if (args.apply) db.exec('ROLLBACK')
    throw err
  } finally {
    db.close()
  }

  console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', dataDir, ...stats }, null, 2))
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
