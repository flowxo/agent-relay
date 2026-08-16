import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useState, useSyncExternalStore } from "react";

import { handleDashboardKey } from "./input.js";
import { mapInkKey } from "./keys.js";
import {
  MIN_COLUMNS,
  MIN_ROWS,
  buildDashboardLayout,
  dashboardPaneMetrics,
  windowAround,
} from "./layout.js";
import type { LayoutLine, LayoutPane } from "./layout.js";
import type { Tone } from "./style.js";
import type { DashboardStore } from "./store.js";

export function renderInkApp(
  store: DashboardStore,
  options: { onQuit: () => void },
) {
  return <DashboardApp store={store} onQuit={options.onQuit} />;
}

function toneProps(tone: Tone): {
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
} {
  switch (tone) {
    case "header":
    case "focus":
      return { color: "cyan", bold: true };
    case "ok":
      return { color: "green" };
    case "warn":
    case "attention":
      return { color: "yellow" };
    case "bad":
      return { color: "red" };
    case "dim":
    case "border":
      return { dimColor: true };
    default:
      return {};
  }
}

function Line(props: { line: LayoutLine; wrap?: "truncate" }) {
  return (
    <Text {...toneProps(props.line.tone)} wrap={props.wrap ?? "truncate"}>
      {props.line.text}
    </Text>
  );
}

function Pane(props: {
  pane: LayoutPane;
  width?: number;
  height?: number;
  flexGrow?: number;
}) {
  const inner =
    props.height === undefined ? props.pane.lines.length : props.height - 2;
  const lines = windowAround(props.pane.lines, Math.max(1, inner));
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={props.pane.focused ? "cyan" : "gray"}
      width={props.width}
      height={props.height}
      flexGrow={props.flexGrow}
      overflow="hidden"
      paddingX={1}
    >
      {lines.map((line, index) => (
        <Line key={index} line={line} />
      ))}
    </Box>
  );
}

function DashboardApp(props: { store: DashboardStore; onQuit: () => void }) {
  useSyncExternalStore(
    (listener) => props.store.subscribe(listener),
    () => props.store.revision,
  );
  const state = props.store.state;
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  }));
  useEffect(() => {
    const onResize = () => {
      setSize({
        columns: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  useInput((input, key) => {
    const mapped = mapInkKey(input, key);
    if (mapped === undefined) {
      return;
    }
    void handleDashboardKey(props.store, mapped)
      .then((result) => {
        if (result === "quit") {
          props.onQuit();
        }
      })
      .catch(() => undefined);
  });
  const columns = size.columns;
  const rows = size.rows;
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Text color="yellow">
          {`Need 40x12, have ${String(columns)}x${String(rows)}.`}
        </Text>
        <Text dimColor>q quit</Text>
      </Box>
    );
  }
  const layout = buildDashboardLayout(state);
  const metrics = dashboardPaneMetrics(columns, rows, layout);
  const splitHeight = Math.max(
    3,
    rows -
      1 -
      (layout.filter === undefined ? 0 : 1) -
      1 -
      (layout.pending === undefined ? 0 : 1) -
      (layout.notice === undefined ? 0 : 1) -
      metrics.detailHeight,
  );
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Line line={layout.header} />
      {layout.filter !== undefined ? <Line line={layout.filter} /> : null}
      {layout.mode === "dashboard" ? (
        <Box flexGrow={1} flexDirection="column">
          <Box height={splitHeight}>
            <Pane
              pane={layout.rail}
              width={metrics.railWidth + 2}
              height={splitHeight}
            />
            <Pane pane={layout.sessions} flexGrow={1} height={splitHeight} />
          </Box>
          {layout.detail !== undefined && metrics.detailHeight > 0 ? (
            <Pane pane={layout.detail} height={metrics.detailHeight} />
          ) : null}
        </Box>
      ) : (
        <Box
          flexGrow={1}
          flexDirection="column"
          borderStyle="single"
          borderColor="cyan"
          paddingX={1}
          overflow="hidden"
          height={metrics.bodyInner + 2}
        >
          {windowAround(layout.body, metrics.bodyInner).map((line, index) => (
            <Line key={index} line={line} />
          ))}
        </Box>
      )}
      {layout.pending !== undefined ? <Line line={layout.pending} /> : null}
      {layout.notice !== undefined ? <Line line={layout.notice} /> : null}
      <Line line={layout.footer} />
    </Box>
  );
}
