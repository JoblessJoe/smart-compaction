#!/usr/bin/env node
/**
 * Mount smart-compaction inside every local preset that already has
 * `@deepseek-ai/dsh-compaction-basic` isolated in its own cordis realm (the
 * shape `@deepseek-ai/dsh-web-app`-based profiles use). Run by hand, never as
 * an install script, so installing never edits a user's presets on its own.
 * `--remove` takes the inserted rows out again (run it before uninstalling).
 *
 * Why this exists: dsh-web-app disables the host-plane `compaction-basic`
 * row and each preset mounts its own private instance inside an isolated
 * cordis group (`isolate: { compaction: true }`). Cordis's isolation is
 * strictly downward — only plugins mounted as descendants of that exact
 * group see the private instance (vendor/cordis/src/service.ts's isolate-tag
 * check). A plugin installed the normal way, as a profile bundle, mounts on
 * the host plane — an ANCESTOR of every preset's realm, not a descendant —
 * so it can never see that isolated compaction service, no matter how it
 * reads it at call time.
 *
 * The only fix is mounting a second, scoped copy of this plugin as a sibling
 * row inside that same isolated group. That row shadows the host-plane one
 * for any agent running that preset (dsh-tools' scoped registrations shadow
 * globals in a different layer — see packages/core/scope/src/store.ts's
 * `ScopedLayers.merge`), so it's safe to coexist with the ordinary
 * `dsh plugin add` bundle-list install used on profiles that DON'T isolate
 * compaction (where the host-plane copy just works on its own).
 *
 * Patches with plain line surgery, not a parse/reserialize round-trip: a
 * full YAML library round-trip (tried first) reflowed unrelated parts of the
 * file (block-scalar indentation, flow-sequence spacing) even though only
 * one line was meant to change — unacceptable for a script whose whole job
 * is not surprising the user. This only ever inserts new lines; every byte
 * of the rest of the file is untouched.
 *
 * Idempotent, best-effort: skipped entirely
 * when `$DSH_HOME/.agent-presets` doesn't exist (simple/non-preset profile —
 * nothing to do), and per-file errors are warned, not thrown. Only ever
 * touches the user's own local preset overrides, never a shipped read-only
 * preset under node_modules.
 * @module scripts/mount-into-presets
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const COMPACTION_BASIC_NAME_RE = /name:\s*['"]?@deepseek-ai\/dsh-compaction-basic['"]?\s*$/
const OUR_NAME = 'smart-compaction'
const ITEM_START_RE = /^(\s*)-\s/

/**
 * @param {string} text
 * @returns {string | null} patched text, or null if nothing to do (already
 *   mounted, or this preset doesn't isolate compaction-basic at all)
 */
export function patchPresetText(text) {
  if (text.includes(`name: ${OUR_NAME}`)) return null // already mounted somewhere

  const lines = text.split('\n')
  const nameLineIdx = lines.findIndex(line => COMPACTION_BASIC_NAME_RE.test(line))
  if (nameLineIdx === -1) return null // this preset doesn't isolate compaction-basic

  // Walk back to the "- id: compaction-basic" (or however it's labeled) item start.
  let itemStartIdx = -1
  for (let i = nameLineIdx; i >= 0; i--) {
    if (ITEM_START_RE.test(lines[i])) {
      itemStartIdx = i
      break
    }
  }
  if (itemStartIdx === -1) return null // unexpected shape, don't guess

  const indent = lines[itemStartIdx].match(ITEM_START_RE)[1].length

  // Scan forward through this list's siblings (indent >= the item's own indent
  // keeps nested `config:` sub-blocks in scope); a strictly shallower non-blank
  // line means the list ended. Track the last non-blank line actually in it so
  // trailing blank lines before the next section are preserved as-is.
  let lastNonBlankIdx = itemStartIdx
  let i = itemStartIdx + 1
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent < indent) break
    lastNonBlankIdx = i
  }

  const pad = ' '.repeat(indent)
  const insertion = ['', `${pad}- id: ${OUR_NAME}`, `${pad}  name: ${OUR_NAME}`]
  lines.splice(lastNonBlankIdx + 1, 0, ...insertion)
  return lines.join('\n')
}

/**
 * Inverse of patchPresetText: drops the `- id: smart-compaction` /
 * `name: smart-compaction` row pair and the blank line inserted before it.
 * @param {string} text
 * @returns {string | null} patched text, or null if not mounted
 */
export function unpatchPresetText(text) {
  const lines = text.split('\n')
  const idx = lines.findIndex((line, i) =>
    line.trim() === `- id: ${OUR_NAME}` && lines[i + 1]?.trim() === `name: ${OUR_NAME}`)
  if (idx === -1) return null
  const start = idx > 0 && lines[idx - 1].trim() === '' ? idx - 1 : idx
  lines.splice(start, idx + 2 - start)
  return lines.join('\n')
}

/**
 * @param {string} filePath
 * @param {boolean} remove
 * @returns {Promise<'mounted' | 'removed' | 'already-mounted' | 'no-isolated-compaction'>}
 */
async function patchPresetFile(filePath, remove) {
  const text = await readFile(filePath, 'utf8')
  if (remove) {
    const unpatched = unpatchPresetText(text)
    if (unpatched === null) return 'no-isolated-compaction'
    await writeFile(filePath, unpatched)
    return 'removed'
  }
  if (text.includes(`name: ${OUR_NAME}`)) return 'already-mounted'
  const patched = patchPresetText(text)
  if (patched === null) return 'no-isolated-compaction'
  await writeFile(filePath, patched)
  return 'mounted'
}

async function main() {
  const remove = process.argv.includes('--remove')
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const presetsDir = join(dshHome, '.agent-presets')
  if (!existsSync(presetsDir)) {
    console.log(`smart-compaction: no local presets at ${presetsDir} — nothing to mount (ordinary profile-bundle install covers this profile).`)
    return
  }

  let entries
  try {
    entries = await readdir(presetsDir, { withFileTypes: true })
  } catch (error) {
    console.warn(`smart-compaction: could not read ${presetsDir}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const filePath = join(presetsDir, entry.name, 'agent.cordis.yml')
    if (!existsSync(filePath)) continue
    try {
      const result = await patchPresetFile(filePath, remove)
      if (result === 'mounted') {
        console.log(`smart-compaction: mounted inside preset "${entry.name}" (${filePath})`)
      } else if (result === 'removed') {
        console.log(`smart-compaction: removed from preset "${entry.name}" (${filePath})`)
      } else if (result === 'already-mounted') {
        console.log(`smart-compaction: already mounted in preset "${entry.name}" — nothing to do.`)
      }
      // 'no-isolated-compaction': this preset doesn't isolate compaction-basic, nothing to do.
    } catch (error) {
      console.warn(`smart-compaction: could not patch ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// Only run when executed directly, so test.js can import the patch functions.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main()
