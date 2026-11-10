"""把文件库里的原始文件（PDF / Word）统一转成 Markdown，供检索和阅读。

用法：python3 scripts/build-markdown.py 159212 rules
需要：pymupdf4llm（pip install pymupdf4llm）、LibreOffice、pandoc。

输出 public/kb/<库编号>/md/<编号>.md：
  - 开头是 YAML 元信息（标题、类型、日期、原件地址等）；
  - 正文保留原件的结构：标题层级、表格、条款（法规的"第X条"单独成为小标题）；
  - 每页开头有 <!-- page N --> 标记，页码与原件一致，便于回到原件定位。

原件不做任何修改。Markdown 只是阅读和检索用的副本：引用仍然要在原件文字中核对（find_quote）。
转换后做一次逐行核对：Markdown 里的每一行文字（表格按单元格）都必须能在原件提取的文字中找到，
找不到的行会列出来，同时写进 md/_check.json。
"""
import json
import re
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path

import pymupdf4llm


def _keep_hyphens() -> None:
    """pymupdf4llm 默认把行尾的连字符当作英文断词去掉（"400-\n889" 会变成 "400889"），
    这会改动原文。这里关掉这一处理，保证转换后的文字与原件一致。"""
    import inspect

    import pymupdf4llm.helpers.document_layout as dl

    src = inspect.getsource(dl)
    a = 'if output.endswith("- ") and len(output.split()[-1]) > 2:'
    b = "1\n                and (old_block, old_line) != (s[\"block\"], s[\"line\"])"
    if a not in src or b not in src:
        raise RuntimeError("pymupdf4llm 版本变了，请检查断词处理的代码位置")
    src = src.replace(a, "if False:").replace(b, "0\n                and (old_block, old_line) != (s[\"block\"], s[\"line\"])")
    exec(compile(src, dl.__file__, "exec"), dl.__dict__)


_keep_hyphens()

ROOT = Path(__file__).resolve().parent.parent
KB = ROOT / "public" / "kb"

CJK = r"\u3400-\u9fff\uf900-\ufaff"
CJK_PUNCT = r"，。、；：？！“”‘’（）《》【】—…·"
JOIN = re.compile(rf"(?<=[{CJK}{CJK_PUNCT}])[ \t]+(?=[{CJK}{CJK_PUNCT}])")
CN_NUM = "一二三四五六七八九十百零〇"
NUMBERING = re.compile(rf"^(\d+[、.．)）]|[（(]\d+[)）]|[（(][{CN_NUM}]+[)）]|[{CN_NUM}]+、|第[{CN_NUM}\d]+[条章节部分款项]|§)")


# ---------------------------------------------------------------- 归一化（与 src/core/textfind.ts 的 normalize 保持一致）

def norm(s: str) -> str:
    out = []
    for i, ch in enumerate(s):
        if ch.isspace() or ch == "\u3000":
            continue
        c = ord(ch)
        if 0xFF01 <= c <= 0xFF5E:
            ch = chr(c - 0xFEE0)
        elif ch in "—–‒―－":
            ch = "-"
        elif ch in "“”「」":
            ch = '"'
        elif ch in "‘’":
            ch = "'"
        elif ch in "〔［":
            ch = "["
        elif ch in "〕］":
            ch = "]"
        if ch == "," and out and out[-1].isdigit() and re.match(r"\s*\d{3}", s[i + 1:]):
            continue
        out.append(ch)
    return "".join(out)


# ---------------------------------------------------------------- 清理

PAGE_FOOTER = [
    re.compile(r"^第\s*\d+\s*页\s*(共\s*\d+\s*页)?$"),
    re.compile(r"^-?\s*\d{1,4}\s*-?$"),
    re.compile(r"^\d+\s*/\s*\d+$"),
]


def clean_inline(s: str) -> str:
    s = s.replace("**", "").replace("__", "")
    s = re.sub(r"</?(mark|u|sup|sub|i|b|span)[^>]*>", "", s)
    s = s.replace("`", "")
    s = re.sub(r"(?<=[" + CJK + CJK_PUNCT + r"])<br>(?=[" + CJK + CJK_PUNCT + r"])", "", s)
    s = s.replace("<br>", " ")
    s = JOIN.sub("", s)
    return s.rstrip()


def is_table(line: str) -> bool:
    return line.lstrip().startswith("|")


def heading_level(line: str, rules: bool) -> tuple[int, str] | None:
    """按中文公文的编号规则识别标题。返回 (级别, 标题文字)。"""
    t = line.strip()
    if not t or is_table(t) or len(t) > 40 or t.endswith(("。", "；", "：", ":")):
        return None
    if re.match(rf"^第[{CN_NUM}]+(部分|章)\s*\S", t):
        return 2, t
    if re.match(rf"^第[{CN_NUM}]+节\s*\S", t):
        return 3, t
    if re.match(r"^§\s*\d+\s*\S", t):
        return 2, t
    if re.match(rf"^[{CN_NUM}]+、\S", t) and len(t) <= 30:
        return 2 if not rules else 3, t
    if re.match(rf"^（[{CN_NUM}]+）\S", t) and len(t) <= 30 and not rules:
        return 3, t
    if re.match(r"^\d+(\.\d+){0,2}\s+\S", t) and len(t) <= 30 and not re.match(r"^\d+(\.\d+)?\s*[%元份]", t):
        depth = t.split()[0].count(".")
        return 2 + depth, t
    return None


ARTICLE = re.compile(rf"^(第[{CN_NUM}]+条)\s*(.*)$")


def structure(lines: list[str], rules: bool) -> list[str]:
    out: list[str] = []
    for raw in lines:
        line = raw.rstrip()
        m = re.match(r"^(#+)\s*(.*)$", line)
        if m:  # pymupdf 按字号识别出的标题，降一级（一级标题留给文件名）
            text = m.group(2).strip()
            if not text:
                continue
            level = min(len(m.group(1)) + 1, 4)
            hl = heading_level(text, rules)
            if hl:
                level = hl[0]
            am = ARTICLE.match(text) if rules else None
            if am:
                out += ["", f"#### {am.group(1)}", ""]
                if am.group(2):
                    out.append(am.group(2))
                continue
            out += ["", "#" * level + " " + text, ""]
            continue
        am = ARTICLE.match(line.strip()) if rules else None
        if am:
            out += ["", f"#### {am.group(1)}", ""]
            if am.group(2):
                out.append(am.group(2))
            continue
        hl = heading_level(line, rules)
        if hl:
            out += ["", "#" * hl[0] + " " + hl[1], ""]
            continue
        out.append(line)
    # 合并多余空行
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip("\n").split("\n")


def page_lines(md: str) -> list[str]:
    md = re.sub(r"<!-- Start of picture text -->.*?<!-- End of picture text -->", "", md, flags=re.S)
    md = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", md)
    lines: list[str] = []
    for l in md.split("\n"):
        l = clean_inline(l)
        s = l.strip()
        if any(p.match(s) for p in PAGE_FOOTER):
            continue
        # pymupdf 把有悬挂缩进的行识别成列表项；原件里的编号本身就在文字中，去掉列表记号。
        # 被拆开的续行（不以编号开头）接回上一行。
        m = re.match(r"^\s*[-*•]\s+(.*)$", l)
        if m:
            body = m.group(1)
            prev = lines[-1] if lines else ""
            if prev.strip() and not is_table(prev) and not prev.lstrip().startswith("#") and not NUMBERING.match(body) and not prev.rstrip().endswith(("。", "；", "：")):
                lines[-1] = prev.rstrip() + body
                continue
            l = body
        lines.append(l)
    return lines


def drop_running_headers(pages: list[list[str]]) -> list[list[str]]:
    """每页都出现的页眉（如定期报告每页顶部的报告名称）去掉。"""
    if len(pages) < 3:
        return pages
    cnt: Counter[str] = Counter()
    for p in pages:
        for l in set(x.strip() for x in p if x.strip() and not is_table(x)):
            cnt[l] += 1
    headers = {l for l, c in cnt.items() if c >= max(3, int(len(pages) * 0.6)) and len(l) <= 60}
    return [[l for l in p if l.strip() not in headers] for p in pages]


# ---------------------------------------------------------------- 转换

def convert_pdf(path: Path, first: int, last: int | None, rules: bool) -> list[list[str]]:
    import pymupdf

    n = pymupdf.open(path).page_count
    last = last or n
    chunks = pymupdf4llm.to_markdown(
        str(path), pages=list(range(first - 1, last)), page_chunks=True, use_ocr=False, ignore_images=True, show_progress=False
    )
    pages = drop_running_headers([page_lines(c["text"]) for c in chunks])
    return [structure(p, rules) for p in pages]


def convert_doc(path: Path) -> list[list[str]]:
    """Word 原件：LibreOffice 转 docx，pandoc 转 Markdown，再按"第X章"分段（与 build-library.ts 的分章一致）。"""
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "source.doc"
        src.write_bytes(path.read_bytes())
        subprocess.run(["soffice", "--headless", "--convert-to", "docx", str(src), "--outdir", d], check=True, capture_output=True, timeout=180)
        md = subprocess.run(["pandoc", str(Path(d) / "source.docx"), "-t", "gfm", "--wrap=none"], check=True, capture_output=True, text=True).stdout
    lines = [clean_inline(l) for l in md.split("\n")]
    lines = [re.sub(r"\\([\[\]()*_#|-])", r"\1", l) for l in lines]
    chapters: list[list[str]] = [[]]
    for l in lines:
        if re.match(rf"^\s*#*\s*(\*\*)?第[{CN_NUM}]+章", l):
            chapters.append([])
        chapters[-1].append(re.sub(r"^#+\s*", "", l))
    chapters = [c for c in chapters if "".join(c).strip()]
    return [structure(c, True) for c in chapters]


def yaml_value(v) -> str:
    if isinstance(v, (int, float)):
        return str(v)
    return json.dumps(str(v), ensure_ascii=False)


def render(item: dict, library: dict, pages: list[list[str]]) -> str:
    first = item.get("firstPage", 1)
    meta = {
        "id": item["id"],
        "title": item["title"],
        "library": "规则库" if library["kind"] == "rules" else f"公告库（{library['name']} {library['code']}）",
        "category": item["category"],
        "type": item["type"],
        "date": item["date"],
    }
    for k in ("effective", "issuer", "docNo", "status"):
        if item.get(k):
            meta[k] = item[k]
    meta["original"] = f"/kb/{library['code']}/{item['pdf']}"
    meta["source"] = item["source"]
    meta["pages"] = f"{first}-{first + item['pages'] - 1}" if not item.get("labels") else f"{item['pages']} 章"
    meta["note"] = "由原件自动转换，供检索和阅读；引用以原件为准，用 find_quote 核对。"
    head = ["---"] + [f"{k}: {yaml_value(v)}" for k, v in meta.items()] + ["---", "", f"# {item['title']}", ""]
    body: list[str] = []
    for i, p in enumerate(pages):
        if item.get("labels"):
            body += [f"<!-- page {i + 1} | {item['labels'][i] if i < len(item['labels']) else ''} -->", ""]
        else:
            body += [f"<!-- page {first + i} -->", ""]
        body += p + [""]
    return "\n".join(head + body).rstrip() + "\n"


# ---------------------------------------------------------------- 核对：Markdown 的文字都来自原件

def check(md: str, original_pages: list[str]) -> dict:
    full = norm("".join(original_pages))
    total = ok = 0
    missing: list[str] = []
    body = md.split("\n---\n", 1)[-1]
    for line in body.split("\n"):
        s = line.strip()
        if not s or s.startswith("<!--") or re.match(r"^\|?\s*:?-{3,}", s):
            continue
        s = re.sub(r"^#+\s*", "", s)
        parts = [c for c in s.strip("|").split("|")] if s.startswith("|") else [s]
        for part in parts:
            n = norm(part)
            if not n:
                continue
            total += len(n)
            if n in full:
                ok += len(n)
            else:
                # 允许一行跨越原件中的分栏：拆成更短的片段再核对
                segs = [x for x in re.split(r"[。；，、]", part) if norm(x)]
                good = sum(len(norm(x)) for x in segs if norm(x) in full)
                ok += good
                if good < len(n) * 0.9:
                    missing.append(part.strip()[:80])
    return {"chars": total, "verified": ok, "ratio": round(ok / total, 4) if total else 1, "unmatched": missing[:20]}


# ---------------------------------------------------------------- 分段：检索的基本单位

CHUNK_TARGET = 600
CHUNK_MAX = 1000


def split_long(text: str, limit: int) -> list[str]:
    """过长的段落按句号切开。"""
    parts, cur = [], ""
    for sent in re.split(r"(?<=[。；])", text):
        if cur and len(cur) + len(sent) > limit:
            parts.append(cur)
            cur = ""
        cur += sent
    if cur:
        parts.append(cur)
    return parts


def split_table(block: list[str], limit: int) -> list[str]:
    """过长的表格按行切开，每一段都带上表头。"""
    if len(block) < 3 or not re.match(r"^\|?\s*:?-{3,}", block[1].strip()):
        return ["\n".join(block)]
    head, rows = block[:2], block[2:]
    out, cur = [], []
    for r in rows:
        if cur and len("\n".join(head + cur + [r])) > limit:
            out.append("\n".join(head + cur))
            cur = []
        cur.append(r)
    if cur:
        out.append("\n".join(head + cur))
    return out


def chunk_markdown(md: str, doc_id: str, title: str) -> list[dict]:
    body = md.split("\n---\n", 1)[-1]
    lines = body.split("\n")
    # 先切成块：段落、表格、标题、页码标记
    blocks: list[tuple[str, object]] = []
    i = 0
    while i < len(lines):
        l = lines[i]
        s = l.strip()
        if not s:
            i += 1
            continue
        m = re.match(r"^<!-- page (\d+)", s)
        if m:
            blocks.append(("page", int(m.group(1))))
            i += 1
            continue
        h = re.match(r"^(#{1,6})\s+(.*)$", s)
        if h:
            blocks.append(("h", (len(h.group(1)), h.group(2).strip())))
            i += 1
            continue
        if is_table(s):
            tb = []
            while i < len(lines) and is_table(lines[i].strip()):
                tb.append(lines[i].strip())
                i += 1
            blocks.append(("table", tb))
            continue
        para = []
        while i < len(lines) and lines[i].strip() and not is_table(lines[i].strip()) and not lines[i].strip().startswith(("#", "<!--")):
            para.append(lines[i].strip())
            i += 1
        blocks.append(("p", "\n".join(para)))

    chunks: list[dict] = []
    stack: dict[int, str] = {}
    page = 1
    cur: list[str] = []
    cur_page = 1
    cur_heading = ""

    def heading_path() -> str:
        return " > ".join(stack[k] for k in sorted(stack) if k > 1)

    def flush(end_page: int):
        nonlocal cur
        text = "\n\n".join(cur).strip()
        if text:
            chunks.append({"doc": doc_id, "title": title, "heading": cur_heading, "page": cur_page, "page_to": end_page, "text": text})
        cur = []

    def add(piece: str):
        nonlocal cur_page, cur_heading
        size = sum(len(x) for x in cur)
        if cur and size + len(piece) > CHUNK_TARGET:
            flush(page)
        if not cur:
            cur_page, cur_heading = page, heading_path()
        cur.append(piece)

    for kind, val in blocks:
        if kind == "page":
            page = val  # type: ignore[assignment]
            continue
        if kind == "h":
            level, text = val  # type: ignore[misc]
            flush(page)
            for k in [k for k in stack if k >= level]:
                del stack[k]
            stack[level] = text
            continue
        if kind == "table":
            for piece in split_table(val, CHUNK_MAX):  # type: ignore[arg-type]
                add(piece)
            continue
        text = val  # type: ignore[assignment]
        for piece in split_long(text, CHUNK_MAX) if len(text) > CHUNK_MAX else [text]:
            add(piece)
    flush(page)
    for n, c in enumerate(chunks):
        c["id"] = f"{doc_id}#{n + 1}"
    return chunks


def convert_item(lib: str, index: dict, item: dict, rules: bool) -> tuple[str, int, dict]:
    lib_dir = Path(lib)
    path = lib_dir / item["pdf"]
    if path.suffix.lower() == ".pdf":
        first = item.get("firstPage", 1)
        pages = convert_pdf(path, first, first + item["pages"] - 1, rules)
    else:
        pages = convert_doc(path)
    md = render(item, index, pages)
    (lib_dir / "md" / f"{item['id']}.md").write_text(md, encoding="utf-8")
    original = json.loads((lib_dir / item["text"]).read_text())
    return item["id"], len(md), check(md, original)


WORKERS = 2


def build(code: str) -> None:
    lib_dir = KB / code
    index = json.loads((lib_dir / "index.json").read_text())
    index.setdefault("kind", "fund")
    out_dir = lib_dir / "md"
    out_dir.mkdir(exist_ok=True)
    check_file = out_dir / "_check.json"
    report = json.loads(check_file.read_text()) if CHUNKS_ONLY and check_file.exists() else {}
    rules = index["kind"] == "rules"
    chunks: list[dict] = []
    if not CHUNKS_ONLY:
        from concurrent.futures import ProcessPoolExecutor

        with ProcessPoolExecutor(max_workers=WORKERS) as pool:
            jobs = [pool.submit(convert_item, str(lib_dir), index, item, rules) for item in index["items"]]
            for job in jobs:
                item_id, size, r = job.result()
                report[item_id] = r
                flag = "" if r["ratio"] >= 0.995 else "  <-- 需要检查"
                print(f"{item_id}  {size:>7} 字符  核对 {r['ratio']:.2%}{flag}", flush=True)
    for item in index["items"]:
        md_file = out_dir / f"{item['id']}.md"
        chunks += chunk_markdown(md_file.read_text(encoding="utf-8"), item["id"], item["title"])
    check_file.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    (lib_dir / "chunks.json").write_text(json.dumps(chunks, ensure_ascii=False), encoding="utf-8")
    print(f"{code}: {len(chunks)} 段", flush=True)


CHUNKS_ONLY = "--chunks-only" in sys.argv

if __name__ == "__main__":
    for code in [a for a in sys.argv[1:] if not a.startswith("--")] or ["159212", "rules"]:
        build(code)
