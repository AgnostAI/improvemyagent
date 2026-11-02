// Imported first by the CLI: hide Node's "SQLite is an experimental feature" notice.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
  const msg = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite/i.test(String(msg))) return;
  return (emit as any)(warning, ...rest);
}) as typeof process.emitWarning;
