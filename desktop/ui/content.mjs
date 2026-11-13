// Text-only presentation: recognize local references without parsing or trusting HTML.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function local(value) {
  if (!value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (value.startsWith('~/') || value.startsWith('/') && !value.startsWith('//')) return true;
  if (!/^file:/i.test(value)) return false;
  try {
    const url = new URL(value);
    return (!url.host || url.host === 'localhost') && !url.search && (!url.hash || /^#L\d+(?:C\d+)?$/.test(url.hash));
  } catch { return false; }
}
function link(target, label = target) {
  return `<a href="#" class="file-link" data-action="reveal-file" data-path="${escape(target)}" title="Reveal in Finder: ${escape(target)}">${escape(label)}</a>`;
}
function trimPunctuation(value) {
  let result = value.replace(/[.,;!?]+$/, '');
  // A balanced pair may be part of a filename; only drop prose's closing parenthesis.
  let extra = (result.match(/\)/g)?.length || 0) - (result.match(/\(/g)?.length || 0);
  while (extra-- > 0 && result.endsWith(')')) result = result.slice(0, -1);
  return result;
}
export function linkedText(value) {
  const text = String(value ?? '');
  // Consume full non-file URLs/Markdown spans too, so their /path parts never become local links.
  const tokens = /\[([^\]\n]{1,512})\]\((<[^>\n]+>|[^\s()]+(?:\([^()\n]*\)[^\s()]*)*)\)|`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'|<([^>\n]+)>|\b[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"'`]+|\/\/[^\s<>"'`]+|(?<![\w./:@%~\\-])(?:~\/|\/(?!\/))[^\s<>"'`\[\]{}]+/g;
  let result = '', end = 0;
  for (const match of text.matchAll(tokens)) {
    // An earlier bare path can absorb an unambiguous directory name containing spaces.
    if (match.index < end) continue;
    result += escape(text.slice(end, match.index));
    let token = match[0], consumed = token.length;
    if (match[1] !== undefined) {
      const target = match[2].startsWith('<') ? match[2].slice(1, -1) : match[2];
      result += local(target) ? link(target, match[1]) : escape(token);
    } else if ([match[3], match[4], match[5], match[6]].some(v => v !== undefined)) {
      const target = [match[3], match[4], match[5], match[6]].find(v => v !== undefined);
      const closingTag = match[6] !== undefined && /^\/[a-z][\w:-]*$/i.test(target);
      result += local(target) && !closingTag ? escape(token[0]) + link(target) + escape(token.at(-1)) : escape(token);
    } else {
      if (token.startsWith('/') && !token.startsWith('//') || token.startsWith('~/')) {
        // E.g. /Volumes/Workspace Archive/file.md. Do not guess a bare final filename with spaces.
        const rest = text.slice(match.index + consumed);
        const continuation = rest.match(/^(?: +[^\s/<>"'`\[\]{}]+\/[^\s<>"'`\[\]{}]*)+/)?.[0];
        if (continuation) { token += continuation; consumed += continuation.length; }
      }
      const target = trimPunctuation(token);
      result += local(target) ? link(target) + escape(token.slice(target.length)) : escape(token);
    }
    end = match.index + consumed;
  }
  return result + escape(text.slice(end));
}

// One report-only primitive, not an HTML renderer. All other content still uses linkedText.
function progressMarkup(candidate) {
  const tag = /^<progress\b([\s\S]*?)><\/progress\s*>$/i.exec(candidate);
  if (!tag || tag[1].length > 2048) return null;
  const attributes = new Map();
  const attribute = /\s+(aria-label|value|max)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/iy;
  let position = 0;
  while (position < tag[1].length) {
    if (/^\s*$/.test(tag[1].slice(position))) break;
    attribute.lastIndex = position;
    const match = attribute.exec(tag[1]);
    if (!match || attributes.has(match[1].toLowerCase())) return null;
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3]);
    position = attribute.lastIndex;
  }
  if (attributes.size !== 3) return null;
  const label = attributes.get('aria-label');
  const numeric = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,12})?$/;
  if (!label?.trim() || label.length > 512 || /[\x00-\x1f\x7f]/.test(label)
      || !numeric.test(attributes.get('value')) || !numeric.test(attributes.get('max'))) return null;
  const value = Number(attributes.get('value')), max = Number(attributes.get('max'));
  if (!Number.isFinite(value) || !Number.isFinite(max) || value < 0 || max <= 0 || value > max || max > 1e12) return null;
  return `<span class="report-progress"><span class="report-progress-label">${escape(label)}</span><progress aria-label="${escape(label)}" value="${value}" max="${max}"></progress></span>`;
}

function codeEnd(text, start) {
  if (start === 0 || text[start - 1] === '\n') {
    const fence = /^[ ]{0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(text.slice(start));
    if (fence) {
      const closing = new RegExp(`^[ ]{0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\r?\\n|$)`, 'gm');
      closing.lastIndex = start + fence[0].length;
      const match = closing.exec(text);
      return match ? closing.lastIndex : text.length;
    }
  }
  if (text[start] !== '`') return null;
  let size = 1;
  while (text[start + size] === '`') size++;
  const delimiter = '`'.repeat(size);
  let end = text.indexOf(delimiter, start + size);
  while (end >= 0 && (text[end - 1] === '`' || text[end + size] === '`')) end = text.indexOf(delimiter, end + size);
  return end < 0 ? text.length : end + size;
}

/** Render only an empty, fully validated progress element outside fenced/inline code. */
export function reportText(value) {
  const text = String(value ?? ''), result = [];
  let plainStart = 0;
  for (let index = 0; index < text.length;) {
    const endCode = codeEnd(text, index);
    if (endCode !== null) {
      result.push(linkedText(text.slice(plainStart, index)), linkedText(text.slice(index, endCode)));
      index = plainStart = endCode;
      continue;
    }
    if (text[index] === '<' && /^<progress(?=\s|>)/i.test(text.slice(index, index + 12))) {
      // Consume a whole candidate even when invalid, so nested tags cannot be promoted.
      const closing = /<\/progress\s*>/i.exec(text.slice(index));
      if (!closing) break;
      const end = index + closing.index + closing[0].length;
      const candidate = text.slice(index, end);
      result.push(linkedText(text.slice(plainStart, index)), progressMarkup(candidate) ?? linkedText(candidate));
      index = plainStart = end;
      continue;
    }
    index++;
  }
  result.push(linkedText(text.slice(plainStart)));
  return result.join('');
}

// Official async-question reply framing. Preparing text does not answer or resolve a question.
export function formatAsyncReply(questions, answers) {
  if(!Array.isArray(questions)||questions.length<1||questions.length>12||!Array.isArray(answers)||answers.length!==questions.length)throw new TypeError('Choose or enter an answer for every question.');
  const encoder=new TextEncoder();
  return questions.map((question,index)=>{
    if(typeof question?.title!=='string'||!question.title.trim()||question.title.length>4096||typeof answers[index]!=='string'||!answers[index].trim()||answers[index].length>4096)throw new TypeError('Choose or enter an answer for every question (up to 4096 characters each).');
    let title='',bytes=0;
    for(const character of question.title){const size=encoder.encode(character).length;if(bytes+size>512)break;title+=character;bytes+=size;}
    return '> '+title.replace(/[\r\n]/g,' ')+'\n\n'+answers[index];
  }).join('\n\n');
}
