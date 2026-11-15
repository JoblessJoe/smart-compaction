/**
 * System-prompt trimming, through dsh's `system-prompt/assemble` waterfall.
 *
 * Sections are the named prompt blocks (persona, per-tool guidance such as
 * the bash or read instructions, plan policy, ...); contexts are dynamic
 * blocks such as AGENTS.md. Both are resent with every request, so on a
 * small window they cost room on every single step. Tool *schemas* stay
 * provider-owned in dsh and cannot be edited here; whole tools can still be
 * hidden (index.js, `hideTools`).
 *
 * Nothing is trimmed by default. A cut always says what was cut, so nothing
 * disappears silently.
 */

/**
 * @param {{ sections: any[], contexts: any[] }} assembly
 * @param {{ dropSections?: string[], sections?: Record<string, string>, maxSectionChars?: number | false, maxContextChars?: number | false }} options
 * @returns the transformed assembly (new object; input untouched).
 */
export function trimAssembly(assembly, options) {
  const drop = new Set(options.dropSections ?? [])
  const replace = options.sections ?? {}
  const cut = (entry, max, kind) => {
    if (!max || entry.text.length <= max) return entry
    return {
      ...entry,
      text: `${entry.text.slice(0, max).trimEnd()}\n[smart-compaction: ${kind} "${entry.name}" cut here to save `
        + `context; ${(entry.text.length - max).toLocaleString('en-US')} more characters not shown.]`,
    }
  }
  return {
    ...assembly,
    sections: assembly.sections
      .filter(s => !drop.has(s.name))
      .map(s => (Object.hasOwn(replace, s.name) ? { ...s, text: replace[s.name] } : cut(s, options.maxSectionChars, 'section'))),
    contexts: assembly.contexts.map(c => cut(c, options.maxContextChars, 'context')),
  }
}

/** One-line size report, so the user can find section names worth trimming. */
export function describeAssembly(assembly) {
  const part = e => `${e.name}=${e.text.length}`
  return `sections: ${assembly.sections.map(part).join(', ') || '(none)'}; `
    + `contexts: ${assembly.contexts.map(part).join(', ') || '(none)'} (characters)`
}
