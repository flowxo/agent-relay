import { parseKey } from "./keys.js";
import type { DashboardKey } from "./keys.js";
import type { DashboardStore } from "./store.js";
import { applyFormToggle, formFields } from "./view-model.js";

export function attachDashboardInput(
  stdin: NodeJS.ReadStream,
  store: () => DashboardStore | undefined,
  onQuit: () => void,
): () => void {
  const onData = (chunk: Buffer | string) => {
    const current = store();
    if (current === undefined) {
      return;
    }
    void (async () => {
      try {
        for (const key of parseKey(chunk)) {
          const result = await handleDashboardKey(current, key);
          if (result === "quit") {
            onQuit();
            return;
          }
        }
      } catch {
        // Keep the host reading stdin so Ctrl-C can still restore the terminal.
      }
    })();
  };
  stdin.on("data", onData);
  return () => {
    stdin.off("data", onData);
  };
}

export async function handleDashboardKey(
  store: DashboardStore,
  key: DashboardKey,
): Promise<"continue" | "quit"> {
  if (key.name === "quit") {
    return "quit";
  }
  if (store.state.pane === "filter") {
    if (key.name === "escape") {
      store.setQuery("");
      store.setPane("list");
      return "continue";
    }
    if (key.name === "enter") {
      store.setPane("list");
      return "continue";
    }
    if (key.name === "backspace") {
      store.setQuery(store.state.query.slice(0, -1));
      return "continue";
    }
    if (key.name === "char" || key.name === "space") {
      const next = key.name === "space" ? " " : key.value;
      store.setQuery(`${store.state.query}${next}`);
      return "continue";
    }
  }

  if (store.state.pane === "form") {
    if (key.name === "escape") {
      store.cancelForm();
      return "continue";
    }
    if (key.name === "enter") {
      await store.submitForm();
      return "continue";
    }
    if (key.name === "up") {
      store.moveFormField(-1);
      return "continue";
    }
    if (key.name === "down") {
      store.moveFormField(1);
      return "continue";
    }
    const request = store.state.selectedRequest;
    const draft = store.state.draft;
    const field = formFields(request?.form)[draft?.fieldIndex ?? 0];
    if (draft === undefined || field === undefined) {
      return "continue";
    }
    if (field.kind === "text") {
      const current = String(draft.values[field.key] ?? "");
      if (key.name === "backspace") {
        store.updateDraft({ [field.key]: current.slice(0, -1) });
      } else if (key.name === "char" || key.name === "space") {
        const next = key.name === "space" ? " " : key.value;
        store.updateDraft({ [field.key]: `${current}${next}` });
      }
      return "continue";
    }
    if (key.name === "space") {
      store.updateDraft(applyFormToggle(draft.values, field));
    }
    return "continue";
  }

  if (key.name === "char" && (key.value === "q" || key.value === "Q")) {
    return "quit";
  }
  if (key.name === "char" && key.value === "?") {
    store.setPane(store.state.helpOpen ? "list" : "help");
    return "continue";
  }
  if (key.name === "escape") {
    if (store.state.helpOpen || store.state.detailOpen) {
      store.state.helpOpen = false;
      store.state.detailOpen = false;
      store.setPane("list");
    }
    return "continue";
  }
  if (key.name === "char" && key.value === "/") {
    store.setPane("filter");
    return "continue";
  }
  if (key.name === "char" && key.value === "p") {
    store.setPane("rail");
    return "continue";
  }
  if (key.name === "char" && key.value === "r") {
    await store.refresh({ force: true, resetHistory: true });
    return "continue";
  }
  if (key.name === "char" && key.value === "n") {
    await store.loadMoreHistory();
    return "continue";
  }
  if (key.name === "char" && key.value === "u") {
    store.applyPendingUpdates();
    return "continue";
  }
  if (key.name === "char" && key.value === "a" && store.state.selectedRequest) {
    store.openForm(store.state.selectedRequest);
    return "continue";
  }
  if (key.name === "char" && key.value === "c") {
    await store.runAction("continue");
    return "continue";
  }
  if (key.name === "char" && key.value === "m") {
    await store.runAction("mute");
    return "continue";
  }
  if (key.name === "char" && key.value === "e") {
    await store.runAction("end");
    return "continue";
  }
  if (key.name === "tab") {
    const order = ["rail", "list", "detail"] as const;
    const current = order.includes(store.state.pane as (typeof order)[number])
      ? (store.state.pane as (typeof order)[number])
      : "list";
    const next = order[(order.indexOf(current) + 1) % order.length] ?? "list";
    if (next === "detail") store.state.detailOpen = true;
    store.setPane(next);
    return "continue";
  }
  if (key.name === "enter") {
    store.activateSelection();
    return "continue";
  }
  if (
    key.name === "up" ||
    (key.name === "char" && (key.value === "k" || key.value === "K"))
  ) {
    if (store.state.pane === "rail") store.moveRail(-1);
    else {
      if (store.state.pane === "detail") store.setPane("list");
      store.moveList(-1);
    }
    return "continue";
  }
  if (
    key.name === "down" ||
    (key.name === "char" && (key.value === "j" || key.value === "J"))
  ) {
    if (store.state.pane === "rail") store.moveRail(1);
    else {
      if (store.state.pane === "detail") store.setPane("list");
      store.moveList(1);
    }
    return "continue";
  }
  if (
    key.name === "left" ||
    (key.name === "char" && (key.value === "h" || key.value === "H"))
  ) {
    if (store.state.pane === "detail") store.setPane("list");
    else store.setPane("rail");
    return "continue";
  }
  if (
    key.name === "right" ||
    (key.name === "char" && (key.value === "l" || key.value === "L"))
  ) {
    if (store.state.pane === "rail") store.setPane("list");
    else {
      store.state.detailOpen = true;
      store.setPane("detail");
    }
    return "continue";
  }
  return "continue";
}
