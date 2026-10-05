'use strict';
// Рендер Markdown живёт прямо в public/index.html (фронт без сборки) — достаём его оттуда
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const code = html.slice(html.indexOf('/* markdown:start'), html.indexOf('/* markdown:end */'));
const Markdown = vm.runInNewContext(`${code}; Markdown`);
const md = (s) => Markdown.render(s);

// Ответ Claude из реальной сессии пользователя (сокращён)
const CLAUDE_ANSWER = `Почти всё у тебя есть. **Докупить нужно только резисторы 220 Ом, 4 шт.** Остальное либо подходит. Всё внёс в \`D:\\MPU\\Gorshok\\Детали проекта — закупка.md\`.

**Что нашлось по каждому номиналу**

| Номинал | Нужно | Что подходит из найденного | Итог |
|---|---|---|---|
| 68 Ом | 2 | \`68EC 109\`, \`109 69ЕС\` | ✅ хватает |
| 220 Ом | 4 | ничего | ❌ **купить** |

**Как это читается, коротко:**
- **Буква на месте запятой — это единица:** Е = Ом, К = кОм. Например, \`4К7\` = 4,7 кОм.
- **69 Ом не бывает.** Это 68 Ом.

**Что проверить мультиметром:**
1. **Оба «1 МОм».** На пределе 2 МОм резистор покажет около 1000 кОм.
2. **\`МЛТ 68 5%\`:** может быть и 68 Ом, и 68 кОм.

**Основную таблицу тоже привёл в порядок:**
- Колонки называются «Где купить в РБ», «Цена в РБ, руб».
- Длинные ссылки сократил до названия сайта.`;

test('ответ Claude: жирный, код, таблица, маркированный и нумерованный списки', () => {
  const out = md(CLAUDE_ANSWER);
  assert.ok(!out.includes('**'), 'не осталось сырых **');
  assert.ok(!out.includes('|---'), 'таблица не осталась текстом');
  assert.match(out, /<strong>Докупить нужно только резисторы 220 Ом, 4 шт\.<\/strong>/);
  assert.match(out, /<code>D:\\MPU\\Gorshok\\Детали проекта — закупка\.md<\/code>/);
  assert.match(out, /<div class="md-table"><table><thead><tr><th>Номинал<\/th><th>Нужно<\/th><th>Что подходит из найденного<\/th><th>Итог<\/th><\/tr><\/thead>/);
  assert.match(out, /<td><code>68EC 109<\/code>, <code>109 69ЕС<\/code><\/td>/);
  assert.match(out, /<td>❌ <strong>купить<\/strong><\/td>/);
  assert.equal((out.match(/<ul>/g) || []).length, 2);
  assert.equal((out.match(/<ol>/g) || []).length, 1);
  assert.match(out, /<li><strong>Оба «1 МОм»\.<\/strong> На пределе/);
  assert.match(out, /<li><strong><code>МЛТ 68 5%<\/code>:<\/strong> может быть/);
  assert.match(out, /<p><strong>Что проверить мультиметром:<\/strong><\/p><ol>/, 'список сразу после абзаца без пустой строки');
});

test('экранирование: HTML из текста не исполняется, опасные ссылки не создаются', () => {
  const out = md('<img src=x onerror=alert(1)> <script>alert(1)</script>\n\n[клик](javascript:alert(1)) [ok](https://example.com/a?b=1&c=2)\n\n`<b>код</b>`');
  assert.ok(!/<img|<script/i.test(out));
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!out.includes('href="javascript'));
  assert.match(out, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.match(out, /<code>&lt;b&gt;код&lt;\/b&gt;<\/code>/);
  const attr = md('[x](https://e.com/"onmouseover="alert(1))');
  // кавычки внутри href экранированы, отдельного атрибута-обработчика не появляется
  assert.ok(!/<a [^>]*\sonmouseover=/.test(attr), attr);
  assert.match(attr, /href="https:\/\/e\.com\/&quot;onmouseover=&quot;alert\(1"/);
});

test('блоки: заголовки, код, цитата, вложенные списки, чекбоксы, разделитель', () => {
  const out = md('# Итог\n\n```js\nconst a = 1 < 2;\n```\n\n> цитата\n\n- один\n  - вложенный\n- два\n\n- [x] сделано\n- [ ] нет\n\n---\nтекст\nвторая строка');
  assert.match(out, /<div class="md-h md-h1">Итог<\/div>/);
  assert.match(out, /<pre class="md-pre"><code>const a = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(out, /<blockquote><p>цитата<\/p><\/blockquote>/);
  // как в CommonMark: пустая строка между пунктами не разрывает список
  assert.match(out, /<ul><li>один<ul><li>вложенный<\/li><\/ul><\/li><li>два<\/li><li>/);
  assert.match(out, /<span class="md-check done">☑<\/span> сделано/);
  assert.match(out, /<hr><p>текст<br>вторая строка<\/p>/);
});

test('snake_case и одиночные звёздочки не превращаются в курсив', () => {
  const out = md('переменная my_var_name и 2 * 3 * 4, но *курсив* и _тоже_');
  assert.match(out, /my_var_name/);
  assert.match(out, /2 \* 3 \* 4/);
  assert.match(out, /<em>курсив<\/em> и <em>тоже<\/em>/);
});

test('голые ссылки становятся кликабельными, пунктуация в конце не захватывается', () => {
  const out = md('Смотри https://ozon.by/product/123, там дешевле.');
  assert.match(out, /<a href="https:\/\/ozon\.by\/product\/123" [^>]*>https:\/\/ozon\.by\/product\/123<\/a>, там/);
});
