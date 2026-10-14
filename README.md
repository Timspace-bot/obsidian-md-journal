# MD Journal

Write in your Obsidian notes as if they were a paper journal.

MD Journal shows a note as **book pages**, one page or a two-page spread, and lets you
**write directly on them**. When a page fills up, your words carry on at the top of the
next page, mid-sentence if needed. When the spread is full, the book turns to a fresh one.
Nothing scrolls.

By default the pages wear your normal Obsidian theme. Turn on **Fixed page** to keep the
same amount of text on every page whatever the window size: the page scales to fit instead
of re-flowing, so page breaks stay put. For a paper notebook, switch the layout to
**Journal pages**: ruled or dotted paper at a real size (A5 by default).

The note stays ordinary Markdown. Whatever you type is saved to the file as you wrote it,
and the regular editor, sync, search and links all keep working.

Forked from [MD Reader](https://github.com/mrrepac/obsidian-md-reader) by mrrepac, which
reads notes as e-book pages. MD Journal keeps its book-style layout and makes the page
editable.

## Features

- **Pages that fill and continue.** Text flows from the bottom of one page to the top of
  the next as you type, delete or paste. The journal follows the caret onto the next page
  or spread with a page-turn.
- **Fixed page sizes:** A6 pocket, B6, A5, half letter, B5, A4 or a custom size in mm.
- **Book spread.** Two facing pages with a spine shadow when the window is wide enough,
  one page when it is narrow. You can also force either mode.
- **Paper:** ruled, dot grid, squared or plain, in white, cream, sepia, gray, night or your
  theme's colours. Every line, headings included, takes a whole number of rulings, so the
  writing stays on the lines. Big headings sit in a blank band, like the title space of a
  journal page, so the ruling never runs through them.
- **Obsidian view (default).** Looks like MD Reader: the columns fill the pane in your
  theme's colours and font, with page buttons at the sides, and it is fully editable. The
  page is cut to fit the pane, so page breaks move when you resize, and the view keeps the
  caret's place.
- **Fixed page.** In the Obsidian view, this keeps the text area of a page constant (A5,
  B5, A4 or a custom size, in your theme font). Resizing the window only scales the page,
  so every page always holds the same text. Use the **Fixed page** setting or the
  **Toggle fixed page** command.
- **Journal pages.** The paper layout. Switch with the monitor button in the header, the
  **Switch between journal pages and Obsidian view** command, or the **Layout** setting.
- **Highlighted code blocks.** Fenced code with a language is coloured by Obsidian's own
  Prism, as in the reading view.
- **Live preview.** `**bold**`, `*italic*`, headings, links, highlights and tags show as
  formatting. Their Markdown marks appear only on the line you are writing. Bullets and
  checkboxes are drawn in place, and you can click a checkbox to tick it.
- **Journal writing aids.** Enter continues lists, quotes and task lists, and Enter on an
  empty item ends the list. Tab and Shift+Tab indent. **Insert date heading** starts
  today's entry. **Insert page break** (`<!-- pagebreak -->`) starts a new page, and the
  setting *New page for each top-level heading* gives every `# ` heading a page of its own.
- **Pictures.** Paste or drop an image and it is saved as an attachment and shown on the
  page, sized to fit the ruling.
- **Your own undo history.** Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) undo and redo, with
  typing grouped the way an editor does it. Ctrl/Cmd+B and Ctrl/Cmd+I toggle bold and
  italic.
- **Turning pages:** the ‹ › buttons, PageUp and PageDown, the mouse wheel, or a swipe on
  touch screens. If the journal has focus, the caret moves to the top of the new page.
  Clicking blank paper puts the caret at the end of the writing on that page.
- **Autosave** shortly after you stop typing. Changes made elsewhere in Obsidian show up
  in the journal. If both sides change at once, what you are typing in the journal is kept.
  Frontmatter (properties) is never shown on the page and is never lost.
- **Opens ready to write.** By default the caret starts at the end of the journal. It can
  return to where you left off instead.

## How to use

- Click the **book icon** in the left ribbon to open your journal note (`Journal.md` by
  default, created if needed).
- To open any note as a journal, run the command **Open current note as journal** or
  right-click the note and choose **Open as journal**.
- **Toggle between journal and editor** switches the same tab between the journal and
  Obsidian's normal editor. The pencil button in the journal's header does the same.
- The **Aa** button in the header opens the page settings: size, paper, colour, font,
  spacing and margins.

### Commands

| Command | What it does |
| --- | --- |
| Open journal | Opens the journal note from the settings. |
| Open current note as journal | Opens the active note on journal pages. |
| Toggle between journal and editor | Switches this tab between journal and Markdown editor. |
| Insert date heading | Adds `## <today>` on its own line (format in settings). |
| Insert page break | Adds a break, so the writing continues on the next page. |
| Next page / Previous page | Turns the pages. |
| Journal appearance | Page size, paper, colours and type. |
| Switch between journal pages and Obsidian view | Toggles the layout. |
| Toggle fixed page (Obsidian view) | Same text per page at any window size, or pages that fill the window. |

## Settings

| Setting | What it does |
| --- | --- |
| Journal note | The note the ribbon button opens. |
| Open at | The end of the journal (default) or where you left off. |
| Open in | New tab, current tab or split. |
| Date heading format | Moment.js format used by *Insert date heading*. |
| Spellcheck, page-turn animation | On or off. |
| Layout | Obsidian view in your theme (default) or journal pages on paper. |
| Fixed page | Obsidian view: keep a constant page size (and text per page) and scale it to the window. |
| Columns, max column width | Obsidian view: one or two columns, and how wide they may get (when not fixed). |
| Page size | A6, B6, A5, half letter, B5, A4 or custom (mm). |
| Pages | Auto, one page or two-page spread. |
| Paper, paper colour | Ruled, dot grid, squared or plain; theme, white, cream, sepia, gray or night. |
| Font, font size, line spacing, margins | Typography of the page (book serif, sans, handwriting, typewriter, theme or custom). |
| Hide Markdown marks | Live-preview style formatting, with marks shown only on the current line. |
| Page numbers | Shown in the outer corner of each page. |
| New page for each top-level heading | Every `# ` heading starts on a new page. |

## How it works

The page is a `contenteditable` surface laid out with CSS columns, one column per page, at a
fixed height. The browser's own text layout therefore decides where a page ends, and text
that no longer fits moves to the next column by itself.

The Markdown source, an array of lines, is the only document model. Edits are intercepted
(`beforeinput`, clipboard and keyboard events), applied to that model, and only the changed
lines are re-rendered. No HTML is ever converted back to Markdown. IME composition (CJK
input, many mobile keyboards) cannot be intercepted, so the browser is allowed to type
those characters and the changed lines are then read back into the model.

Large journals stay responsive. In testing, a 536-page (600k-character) note took about
8 ms per keystroke in Chromium.

## Limitations

- Tables, callouts, embeds of other notes and HTML are shown as their Markdown source, not
  rendered.
- A single image taller than a page is shrunk to fit one page. A single unbroken block,
  such as a very long code line, wraps rather than splitting oddly.
- On phones the on-screen keyboard shrinks the space for the page, so the page is scaled
  down while you type.

## Installation

Not yet in the Community Plugins catalog. To install by hand, copy `main.js`,
`manifest.json` and `styles.css` into `<your vault>/.obsidian/plugins/md-journal/`, then
enable **MD Journal** under Settings → Community plugins. It can be installed next to MD
Reader without conflict.

## Development

Plain JavaScript with **no build step**. `main.js` is the source and ships as is.

```
node tests/logic.mjs        # Markdown rendering, line kinds, frontmatter, word/grapheme boundaries, page geometry
node tests/serve.cjs        # then open http://localhost:5178/tests/harness.html
```

The harness runs the real editor in a browser with a stubbed Obsidian host, using sample
journal text. It has switches for page mode, paper colour and paper style.

## License

[MIT](LICENSE). MD Reader © mrrepac; MD Journal changes © Timspace-bot.
