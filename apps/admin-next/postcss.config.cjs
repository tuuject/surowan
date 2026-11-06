const path = require('node:path');

// Panda generates the Koi styles; Tailwind stays for the existing page layout
// utilities while the shared controls and the shell use Koi recipes. Absolute
// paths keep the config resolvable whichever directory the dev server starts in.
module.exports = {
  plugins: {
    '@pandacss/dev/postcss': {
      configPath: path.join(__dirname, 'panda.config.ts'),
      cwd: __dirname,
    },
    '@tailwindcss/postcss': {},
  },
};
