const rendered = new WeakMap();

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function safeHref(value = "") {
  const href = String(value).trim();
  if (/^(https?:|mailto:)/i.test(href) || href.startsWith("/") || href.startsWith("#")) {
    return escapeHtml(href);
  }
  return "#";
}

function renderInline(value = "") {
  const tokens = [];
  const stash = (html) => {
    const token = `\u0000MDTOKEN${tokens.length}\u0000`;
    tokens.push(html);
    return token;
  };

  let text = String(value);

  text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_, label, href) => {
    const safe = safeHref(href);
    if (safe === "#" && String(href).trim() !== "#") return escapeHtml(label);
    return stash(`<a href="${safe}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
  });

  text = escapeHtml(text)
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");

  tokens.forEach((html, index) => {
    text = text.replace(`\u0000MDTOKEN${index}\u0000`, html);
  });
  return text;
}

function isTableDivider(line = "") {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function splitTableRow(line = "") {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

export function renderMarkdown(source = "") {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const language = fence[1].trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(`
        <div class="md-code-block">
          <div class="md-code-header">
            <span>${escapeHtml(language || "code")}</span>
            <button type="button" class="md-copy-code" aria-label="複製程式碼">複製</button>
          </div>
          <pre><code${language ? ` data-language="${escapeHtml(language)}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>
        </div>
      `);
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      output.push(`
        <div class="md-table-wrap"><table>
          <thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("")}</tr></thead>
          <tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${renderInline(row[cellIndex] || "")}</td>`).join("")}</tr>`).join("")}</tbody>
        </table></div>
      `);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${quote.map(renderInline).join("<br>")}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    if (unordered) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-+*]\s+(.+)$/);
        if (!item) break;
        const task = item[1].match(/^\[([ xX])\]\s+(.+)$/);
        items.push(task
          ? `<li class="md-task"><input type="checkbox" disabled ${task[1].toLowerCase() === "x" ? "checked" : ""}><span>${renderInline(task[2])}</span></li>`
          : `<li>${renderInline(item[1])}</li>`);
        index += 1;
      }
      output.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${renderInline(item[1])}</li>`);
        index += 1;
      }
      output.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim()) {
      const next = lines[index];
      if (
        /^\s*```/.test(next)
        || /^\s*#{1,6}\s+/.test(next)
        || /^\s*>\s?/.test(next)
        || /^\s*[-+*]\s+/.test(next)
        || /^\s*\d+[.)]\s+/.test(next)
        || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(next)
        || (next.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1]))
      ) break;
      paragraph.push(next.trim());
      index += 1;
    }
    output.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
  }

  return output.join("");
}

export function enhanceMarkdown(element) {
  if (!(element instanceof HTMLElement)) return;
  const previous = rendered.get(element);
  if (previous && element.innerHTML === previous.html) return;

  const source = element.textContent || "";
  if (!source) return;
  const html = renderMarkdown(source);
  rendered.set(element, { source, html });
  element.innerHTML = html;
}

export function enhanceMarkdownIn(root = document) {
  root.querySelectorAll(".message.assistant .message-content").forEach(enhanceMarkdown);
}

if (typeof document !== "undefined") {
  document.addEventListener("click", async (event) => {
    const button = event.target.closest(".md-copy-code");
    if (!button) return;
    const code = button.closest(".md-code-block")?.querySelector("code")?.textContent || "";
    try {
      await navigator.clipboard.writeText(code);
      const original = button.textContent;
      button.textContent = "已複製";
      setTimeout(() => { button.textContent = original; }, 1200);
    } catch {
      button.textContent = "複製失敗";
    }
  });
}
