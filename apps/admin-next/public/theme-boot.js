(() => {
  // `data-theme` is applied before the first paint so Koi's Panda conditions
  // never flash the wrong theme. The stored mode is shared with the panel's
  // theme switch (`admin-theme`: light / dark / system).
  const apply = (mode) => {
    const dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  };
  try {
    const mode = localStorage.getItem('admin-theme');
    apply(mode);
    // Mirror the explicit Koi choice for a desktop shell's preload, which
    // watches `koi-theme` to theme its own window chrome. A failed mirror
    // write must not roll back the theme we already applied from `admin-theme`.
    try {
      if (mode === 'light' || mode === 'dark') {
        localStorage.setItem('koi-theme', mode);
      } else {
        localStorage.removeItem('koi-theme');
      }
    } catch (_) {
      // The mirror is optional; the panel theme is already applied.
    }
  } catch (_) {
    try {
      apply('system');
    } catch (_) {
      // nothing we can do
    }
  }
})();
