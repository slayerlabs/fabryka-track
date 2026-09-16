import content from "./BenchmarkMetricContent.html?raw";
export function MetricHelp({ expanded = false }: { expanded?: boolean }) {
  return (
    <details
      className="panel guide-notes metric-help"
      open={expanded || undefined}
      style={{ margin: "20px 0" }}
    >
      <summary>
        <strong>What do loss, perplexity, validation and test mean?</strong>
      </summary>
      <div dangerouslySetInnerHTML={{ __html: content }} />
      {!expanded && <a href="/guide">Training guide with example curves →</a>}
    </details>
  );
}
