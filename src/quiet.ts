// Node 25+ prints an ExperimentalWarning when a dependency probes `localStorage`; in a terminal it lands in the middle
// of our prompts. Imported first by cli.ts (ES modules run their imports in order), so it is in place before any probe.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w);
});
