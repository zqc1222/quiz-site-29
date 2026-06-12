import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path


NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def clean_text(value):
    value = value.replace("\xa0", " ")
    return re.sub(r"\s+", " ", value).strip()


def strip_bullet(value):
    return clean_text(re.sub(r"^[\s\u00b7]+", "", value))


def is_underlined(run):
    rpr = run.find("w:rPr", NS)
    if rpr is None:
        return False
    underline = rpr.find("w:u", NS)
    if underline is None:
        return False
    val = underline.attrib.get(W + "val", "single")
    return val not in {"none", "0", "false"}


def read_paragraphs(docx_path):
    with zipfile.ZipFile(docx_path) as archive:
        xml = archive.read("word/document.xml")
    root = ET.fromstring(xml)
    paragraphs = []
    for index, para in enumerate(root.findall(".//w:body/w:p", NS), start=1):
        runs = []
        for run in para.findall("w:r", NS):
            text = "".join(node.text or "" for node in run.findall(".//w:t", NS))
            if text:
                runs.append({"text": text, "underlined": is_underlined(run)})
        text = clean_text("".join(run["text"] for run in runs))
        if text:
            paragraphs.append({"index": index, "text": text, "runs": runs})
    return paragraphs


def build_cloze(paragraph):
    parts = []
    answers = []
    blank_count = 0
    for run in paragraph["runs"]:
        text = run["text"]
        answer = clean_text(text)
        if run["underlined"] and answer:
            blank_count += 1
            answers.append(answer)
            parts.append("____")
        else:
            parts.append(text)
    cloze = clean_text("".join(parts))
    cloze = re.sub(r"____(\s*____)+", lambda m: "____" * (m.group(0).count("____")), cloze)
    return strip_bullet(cloze), answers


def find_heading(paragraphs, needle, start=0):
    for i in range(start, len(paragraphs)):
        if needle in paragraphs[i]["text"]:
            return i
    raise ValueError(f"Heading not found: {needle!r}")


def find_option_markers(value):
    markers = []
    for index, char in enumerate(value):
        if char not in "ABCDEF":
            continue
        prev_char = value[index - 1] if index > 0 else ""
        next_char = value[index + 1] if index + 1 < len(value) else ""
        next_next = value[index + 2] if index + 2 < len(value) else ""
        has_punct = next_char in ".\u3001\uff0e"
        at_start = index == 0
        separated = prev_char.isspace()
        no_ascii_word = not next_char.isascii() or next_char.isspace() or next_char.isdigit()
        if has_punct or (at_start and no_ascii_word) or (separated and no_ascii_word):
            end = index + 1
            if has_punct:
                end += 1
            while end < len(value) and value[end].isspace():
                end += 1
            markers.append({"label": char, "start": index, "end": end})
    return markers


def split_options(value):
    value = clean_text(value.replace("\uff0e", "."))
    markers = find_option_markers(value)
    if not markers:
        return {}
    if len(markers) == 1 and markers[0]["label"] != "A" and markers[0]["start"] != 0:
        return {}

    options = {}
    first = markers[0]
    prefix = clean_text(value[: first["start"]].strip(".\u3001,; "))
    if prefix and first["label"] != "A":
        options["A"] = prefix

    for i, marker in enumerate(markers):
        next_start = markers[i + 1]["start"] if i + 1 < len(markers) else len(value)
        option_text = clean_text(value[marker["end"] : next_start].strip(".\u3001,; "))
        if option_text:
            options[marker["label"]] = option_text
    return options


ANSWER_RE = re.compile(r"[\(\uff08]\s*([A-F]{1,6})\s*[\)\uff09]", re.I)


def parse_choice_block(block, number):
    raw_lines = [item["text"] for item in block]
    block_text = " ".join(raw_lines)
    answers = [match.upper() for match in ANSWER_RE.findall(block_text)]
    answer = "".join(answers[:1])

    prompt_lines = []
    options = {}

    for raw in raw_lines:
        line = strip_bullet(ANSWER_RE.sub("", raw))
        if not line:
            continue
        line_options = split_options(line)
        if line_options:
            options.update(line_options)
        else:
            prompt_lines.append(line)

    prompt = clean_text(" ".join(prompt_lines))
    qtype = "multiple" if len(answer) > 1 else "single"
    return {
        "id": f"C{number:03d}",
        "type": qtype,
        "section": "\u9009\u62e9\u9898",
        "prompt": prompt,
        "options": options,
        "answer": list(answer),
        "sourceLines": [item["index"] for item in block],
        "raw": raw_lines,
    }


def parse_choices(paragraphs, start, end):
    blocks = []
    current = []
    for paragraph in paragraphs[start:end]:
        text = paragraph["text"]
        if text.startswith("\u00b7") and current:
            blocks.append(current)
            current = [paragraph]
        else:
            current.append(paragraph)
    if current:
        blocks.append(current)
    return [parse_choice_block(block, index) for index, block in enumerate(blocks, start=1)]


JUDGE_RE = re.compile(r"^\s*\d+[\.\u3001]\s*(.*?)\s*[\(\uff08]\s*([^\)\uff09]+?)\s*[\)\uff09]\s*$")


def parse_judgements(paragraphs, start, end):
    questions = []
    for paragraph in paragraphs[start:end]:
        match = JUDGE_RE.match(paragraph["text"])
        if not match:
            continue
        answer_text = match.group(2).strip()
        truth = answer_text in {"\u221a", "\u2713", "\u5bf9", "true", "T"}
        questions.append(
            {
                "id": f"J{len(questions) + 1:03d}",
                "type": "judge",
                "section": "\u5224\u65ad\u9898",
                "prompt": clean_text(match.group(1)),
                "answer": truth,
                "answerText": "\u221a" if truth else "\u00d7",
                "sourceLines": [paragraph["index"]],
                "raw": paragraph["text"],
            }
        )
    return questions


def parse_short_answers(paragraphs, start, end):
    blocks = []
    current = None
    for paragraph in paragraphs[start:end]:
        text = paragraph["text"]
        is_question = bool(re.match(r"^\d+[\u3001\.]", text)) or text.startswith("\u00b7")
        if is_question:
            if current:
                blocks.append(current)
            current = {"question": paragraph, "answer": []}
        elif current:
            current["answer"].append(paragraph)
    if current:
        blocks.append(current)

    questions = []
    for number, block in enumerate(blocks, start=1):
        prompt = strip_bullet(re.sub(r"^\d+[\u3001\.]\s*", "", block["question"]["text"]))
        answer_lines = [re.sub(r"^\u7b54[:\uff1a]\s*", "", item["text"]).strip() for item in block["answer"]]
        questions.append(
            {
                "id": f"S{number:03d}",
                "type": "short",
                "section": "\u7b80\u7b54\u9898",
                "prompt": prompt,
                "answer": "\n".join(line for line in answer_lines if line),
                "answerLines": answer_lines,
                "sourceLines": [block["question"]["index"]]
                + [item["index"] for item in block["answer"]],
                "raw": [block["question"]["text"]] + [item["text"] for item in block["answer"]],
            }
        )
    return questions


def parse_knowledge(paragraphs, start, end):
    questions = []
    for number, paragraph in enumerate(paragraphs[start:end], start=1):
        prompt, answers = build_cloze(paragraph)
        original = strip_bullet(paragraph["text"])
        if not answers:
            answers = [original]
            prompt = "\u56de\u5fc6\u5e76\u590d\u8ff0\uff1a" + original
        questions.append(
            {
                "id": f"K{number:03d}",
                "type": "fill",
                "section": "\u77e5\u8bc6\u70b9/\u586b\u7a7a",
                "prompt": prompt,
                "answer": answers,
                "answerText": "\uff1b".join(answers),
                "original": original,
                "sourceLines": [paragraph["index"]],
            }
        )
    return questions


def main():
    project = Path(__file__).resolve().parents[1]
    source = project / "source.docx"
    output = project / "questions.js"
    if len(sys.argv) > 1:
        source = Path(sys.argv[1])
    paragraphs = read_paragraphs(source)

    knowledge_heading = find_heading(paragraphs, "\u77e5\u8bc6\u70b9\u5408\u96c6")
    choice_heading = find_heading(paragraphs, "\u9009\u62e9", knowledge_heading + 1)
    judge_heading = find_heading(paragraphs, "\u5224\u65ad", choice_heading + 1)
    short_heading = find_heading(paragraphs, "\u7b80\u7b54", judge_heading + 1)

    outline = [item["text"] for item in paragraphs[:knowledge_heading]]
    knowledge_note = paragraphs[knowledge_heading + 1]["text"] if knowledge_heading + 1 < len(paragraphs) else ""

    knowledge = parse_knowledge(paragraphs, knowledge_heading + 2, choice_heading)
    choices = parse_choices(paragraphs, choice_heading + 1, judge_heading)
    judgements = parse_judgements(paragraphs, judge_heading + 1, short_heading)
    shorts = parse_short_answers(paragraphs, short_heading + 1, len(paragraphs))
    questions = knowledge + choices + judgements + shorts

    data = {
        "title": "\u7b2c\u4e8c\u5341\u4e5d\u671f\u9898\u5e93",
        "sourceFile": str(source.name),
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "outline": outline,
        "knowledgeNote": knowledge_note,
        "counts": {
            "fill": len(knowledge),
            "single": len([q for q in choices if q["type"] == "single"]),
            "multiple": len([q for q in choices if q["type"] == "multiple"]),
            "judge": len(judgements),
            "short": len(shorts),
            "total": len(questions),
        },
        "questions": questions,
    }

    payload = json.dumps(data, ensure_ascii=False, indent=2)
    output.write_text("window.QUIZ_BANK = " + payload + ";\n", encoding="utf-8")
    print(json.dumps(data["counts"], ensure_ascii=False, indent=2))
    print(f"Wrote {output}")


if __name__ == "__main__":
    main()
