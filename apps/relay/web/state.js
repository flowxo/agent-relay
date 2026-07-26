const laneOrder = new Map([
  ["crashed", 0],
  ["stale", 1],
  ["waiting", 2],
  ["running", 3],
  ["muted", 4],
  ["ended", 5],
]);

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function buildResponse(item, values) {
  if (item.form?.kind === "text") {
    return { kind: "text", text: String(values.value ?? "") };
  }
  if (item.form?.kind === "single-select") {
    return { kind: "option", optionId: String(values.value ?? "") };
  }
  if (item.form?.kind === "multi-select") {
    return {
      kind: "multi-select",
      optionIds: Array.isArray(values.value) ? values.value.map(String) : [],
    };
  }
  if (item.form?.kind !== "question-set") {
    return undefined;
  }
  return {
    kind: "question-set",
    answers: item.form.questions.map((question) => {
      const value = values[question.questionId];
      if (question.kind === "multi-select") {
        return {
          questionId: question.questionId,
          kind: question.kind,
          optionIds: Array.isArray(value) ? value.map(String) : [],
        };
      }
      if (question.kind === "free-text") {
        return {
          questionId: question.questionId,
          kind: question.kind,
          text: String(value ?? ""),
        };
      }
      return {
        questionId: question.questionId,
        kind: question.kind,
        optionId: String(value ?? ""),
      };
    }),
  };
}

export function reconcileSessions(sessions) {
  const byKey = new Map();
  for (const session of sessions) {
    byKey.set(session.sessionKey, session);
  }
  return [...byKey.values()].sort((left, right) => {
    const laneDifference =
      (laneOrder.get(left.state) ?? 99) - (laneOrder.get(right.state) ?? 99);
    if (laneDifference !== 0) {
      return laneDifference;
    }
    const activityDifference =
      Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
    return (
      activityDifference ||
      left.repository.localeCompare(right.repository) ||
      left.sessionKey.localeCompare(right.sessionKey)
    );
  });
}

export function sortAttention(attention) {
  const byRequest = new Map();
  for (const item of attention) {
    byRequest.set(item.requestId, item);
  }
  return [...byRequest.values()].sort(
    (left, right) =>
      Date.parse(left.expiresAt) - Date.parse(right.expiresAt) ||
      left.sessionKey.localeCompare(right.sessionKey) ||
      left.requestId.localeCompare(right.requestId),
  );
}

export function filterSessions(sessions, filters) {
  const query = filters.query.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    if (filters.state !== "all" && session.state !== filters.state) {
      return false;
    }
    if (filters.harness !== "all" && session.harness !== filters.harness) {
      return false;
    }
    if (
      filters.repository !== "all" &&
      session.repository !== filters.repository
    ) {
      return false;
    }
    if (query.length === 0) {
      return true;
    }
    return [
      session.repository,
      session.branch ?? "",
      session.harness,
      session.state,
      session.sessionKey,
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}

export function summarizeSessions(sessions, attention) {
  return {
    attention: attention.length,
    running: sessions.filter((session) => session.state === "running").length,
    risk: sessions.filter(
      (session) => session.state === "crashed" || session.state === "stale",
    ).length,
  };
}

export function mergeCursor(current, candidate) {
  return Number.isSafeInteger(candidate) && candidate > current
    ? candidate
    : current;
}

export function parseSseBlock(block) {
  let event = "message";
  let id;
  const data = [];
  for (const line of block.replaceAll("\r", "").split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("id:")) id = Number(line.slice(3).trim());
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return {
    event,
    ...(Number.isSafeInteger(id) ? { id } : {}),
    data: data.join("\n"),
  };
}
