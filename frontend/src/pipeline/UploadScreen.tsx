export function UploadScreen() {
  return (
    <main className="pipeline">
      <h1>Data Pipeline Upload</h1>
      <p>JSONL or Parquet. Maximum encoded input: 512 MiB.</p>
      <label>
        Input file
        <input type="file" accept=".jsonl,.parquet" />
      </label>
      <label>
        Source
        <input pattern="[a-z0-9][a-z0-9_]*" />
      </label>
      <label>
        Added date
        <input type="date" />
      </label>
    </main>
  );
}
