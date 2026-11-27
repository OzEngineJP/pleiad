const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

export function interactionQuestions({ kind, summary, spec }, approvalLabels) {
  if (kind === 'approval') {
    const subject = nonEmpty(spec?.subject) ? spec.subject : summary;
    if (!nonEmpty(subject) || subject.length > 2000) return [];
    return [{ id: 'approval', question: subject, header: typeof spec?.detail === 'string' ? spec.detail.slice(0, 2000) : '',
      options: approvalLabels.map(([value, label]) => ({ value, label })), multiSelect: false, custom: false }];
  }
  const requested = Array.isArray(spec?.questions) && spec.questions.length
    ? spec.questions : [{ id: 'answer', prompt: summary }];
  const seen = new Set();
  const ids = new Set();
  const normalized = [];
  for (const question of requested.slice(0, 8)) {
    const prompt = question?.prompt;
    if (!nonEmpty(prompt) || prompt.length > 2000 || seen.has(prompt)) return [];
    const id = nonEmpty(question.id) ? question.id : prompt;
    if (ids.has(id)) return [];
    seen.add(prompt);
    ids.add(id);
    const options = Array.isArray(question.choices) ? question.choices.slice(0, 12).flatMap(choice => {
      const label = typeof choice === 'string' ? choice : choice?.label;
      if (!nonEmpty(label)) return [];
      return [{ label, value: typeof choice?.value === 'string' ? choice.value : label,
        description: typeof choice?.description === 'string' ? choice.description : '' }];
    }) : [];
    normalized.push({ id, question: prompt, header: typeof question.header === 'string' ? question.header : '',
      options, multiSelect: question.type === 'multi_select' || question.multiSelect === true,
      ...(question.custom === false ? { custom: false } : {}) });
  }
  return normalized;
}

export function hostTools(runtimes) {
  const mcpServers = {};
  const instructions = [];
  for (const [name, runtime] of Object.entries(runtimes)) {
    if (!runtime?.url || !runtime.headers) continue;
    mcpServers[name] = { url: runtime.url, headers: runtime.headers };
    if (runtime.instructions || runtime.prompt) instructions.push(runtime.instructions || runtime.prompt);
  }
  return { mcpServers, instructions: instructions.join('\n\n') };
}

export function editableField(toolName) {
  return toolName === 'write_file' ? 'content' : toolName === 'apply_patch' ? 'patch' : null;
}
