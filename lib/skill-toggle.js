const actions = new Set(["list", "on", "off", "toggle"])

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  const first = trimmed[0]
  const last = trimmed.at(-1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  return trimmed
}

export function stripSkillToggleCommand(input) {
  const text = String(input ?? "").trim()
  if (/^\/?skill-toggle(?:\s+|$)/i.test(text) && text.startsWith("/")) {
    return text.replace(/^\/skill-toggle(?:\s+|$)/i, "").trim()
  }
  if (/^skill-toggle\s+(?:list|on|off|toggle)(?:\s+|$)/i.test(text)) {
    return text.replace(/^skill-toggle(?:\s+|$)/i, "").trim()
  }
  return text
}

export function skillToggleKeys(skill) {
  return [...new Set([skill?.id, skill?.name].filter((value) => typeof value === "string" && value))]
}

export function parseSkillCommand(input) {
  const text = stripSkillToggleCommand(input)
  if (!text) return { action: "list" }

  const [first, ...rest] = text.split(/\s+/)
  if (actions.has(first)) {
    if (first === "list") {
      return rest.length ? { error: "Use: /skill-toggle [list|on|off|toggle] [name]" } : { action: "list" }
    }
    const name = unquote(rest.join(" "))
    if (!name) return { error: `Use: /skill-toggle ${first} <name>` }
    return { action: first, name }
  }

  return { action: "toggle", name: unquote(text) }
}
