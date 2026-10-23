import '@fontsource/open-sans/400.css'
import '@fontsource/open-sans/400-italic.css'
import '@fontsource/open-sans/600.css'
import '@fontsource/open-sans/700.css'
import '@fontsource/open-sans/700-italic.css'
import '@fontsource/raleway/400.css'
import '@fontsource/raleway/500.css'
// Only Crepe's functional component styles; typography comes from the themes.
import '@milkdown/crepe/theme/common/prosemirror.css'
import '@milkdown/crepe/theme/common/cursor.css'
import '@milkdown/crepe/theme/common/code-mirror.css'
import '@milkdown/crepe/theme/common/list-item.css'
import '@milkdown/crepe/theme/common/link-tooltip.css'
import '@milkdown/crepe/theme/common/table.css'
import '@milkdown/crepe/theme/common/latex.css'
import 'katex/dist/katex.min.css'
import './themes/github.css'
import './themes/gothic.css'
import './themes/newsprint.css'
import './themes/night.css'
import './themes/pixyll.css'
import './themes/whitey.css'
import './styles/base.css'
import './styles/editor.css'
import { App } from './app'

const app = new App()
// Handy for poking at the editor from devtools during development.
if (import.meta.env.DEV) {
  Object.assign(window, {
    mtyporaApp: app,
    mtyporaRoundTrip: async () => (await import('./roundtrip')).runRoundTrip(app.testHarness())
  })
}
app.start().catch((error) => {
  console.error('[m-typora] failed to start', error)
})
