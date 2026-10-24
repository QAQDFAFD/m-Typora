import { app } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CustomTheme } from '../shared/api'

const README = `# m-typora 自定义主题

把 \`.css\` 文件放进这个文件夹，重启 m-typora 后就能在「主题」菜单和「偏好设置 › 外观」里选择它。
主题名取自文件名：\`my-theme.css\` 显示为「My Theme」。以 \`.user.css\` 结尾的文件和 \`base.css\` 不会被当作主题。

自定义主题叠加在默认的 Github 主题之上，只需要写想改的部分。常用的变量：

\`\`\`css
:root {
  --bg-color: #fdf6e3;          /* 页面背景 */
  --text-color: #586e75;        /* 正文 */
  --heading-color: #073642;     /* 标题 */
  --link-color: #268bd2;        /* 链接 */
  --select-text-bg-color: #eee8d5;
  --side-bar-bg-color: #f5efdc; /* 侧边栏 */
  --code-bg-color: #f5efdc;     /* 代码块 */
  --monospace: 'JetBrains Mono', monospace;
}

#write {
  font-family: Georgia, 'Songti SC', serif;
}

#write h1 {
  text-align: center;
}
\`\`\`

深色主题请在 \`:root\` 里加上 \`color-scheme: dark;\`，图表和代码块会随之使用深色配色。
主题里用到的图片和字体可以放在这个文件夹里，用相对路径引用，例如 \`url("my-theme/font.woff2")\`。
`

export function themesDir(): string {
  return join(app.getPath('userData'), 'themes')
}

/** "my-theme.css" → "My Theme", like Typora's theme menu. */
function labelOf(file: string): string {
  return file
    .replace(/\.css$/i, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

/** Relative url(...) references point into the theme folder once the CSS is inlined. */
function absolutizeUrls(css: string, dir: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _quote: string, url: string) =>
    /^(data:|https?:|file:|#|\/)/i.test(url.trim()) ? match : `url("${pathToFileURL(join(dir, url.trim())).href}")`
  )
}

/** Creates the theme folder (with a short guide) on first use. */
export async function ensureThemesDir(): Promise<string> {
  const dir = themesDir()
  await mkdir(dir, { recursive: true })
  const readme = join(dir, 'README.md')
  if (!existsSync(readme)) await writeFile(readme, README, 'utf8')
  return dir
}

export async function listCustomThemes(): Promise<CustomTheme[]> {
  const dir = await ensureThemesDir().catch(() => themesDir())
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => /\.css$/i.test(name) && !/\.user\.css$/i.test(name) && name.toLowerCase() !== 'base.css')
    .sort((a, b) => a.localeCompare(b))
  const themes = await Promise.all(
    files.map(async (file): Promise<CustomTheme | null> => {
      const css = await readFile(join(dir, file), 'utf8').catch(() => null)
      return css === null ? null : { id: `custom:${file.replace(/\.css$/i, '')}`, label: labelOf(file), css: absolutizeUrls(css, dir) }
    })
  )
  return themes.filter((theme): theme is CustomTheme => theme !== null)
}
