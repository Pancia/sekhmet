#!/usr/bin/env python3
"""Native messaging host for the element picker's "Ask Claude" button.

Receives one message describing the picked element, asks Claude for uBlock
Origin rules through ~/dotfiles/bin/claude-p, and replies with them. Runs only
when the button is pressed.

Message shape (from picker.js, relayed by background.js):
    {"host": "www.pinterest.com", "path": "/", "goal": "<optional>",
     "context": "<trimmed HTML of the element, its ancestors and siblings>"}

Reply:
    {"ok": true, "suggestions": [{"selector": "...", "why": "..."}],  # best first
     "recommended": 2, "recommendation": "<why that one>", "note": "..."}
    {"ok": false, "error": "..."}

claude-p supplies the deadline, the clean room (--safe-mode) and the check on
claude's own error flag. --json-schema makes the answer data rather than prose.
"""

import json
import os
import struct
import subprocess
import sys
from pathlib import Path

HOME = Path.home()
CLAUDE_P = str(HOME / "dotfiles" / "bin" / "claude-p")
# claude lives in ~/.local/bin; claude-p needs GNU timeout and jq (Homebrew).
CHILD_PATH = f"{HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{HOME}/dotfiles/bin"
WORK_DIR = HOME / ".local" / "share" / "sekhmet"
TIMEOUT_S = 120
MAX_CONTEXT = 30000

SCHEMA = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "why": {"type": "string"},
                },
                "required": ["selector", "why"],
            },
        },
        "recommended": {"type": "integer"},
        "recommendation": {"type": "string"},
        "note": {"type": "string"},
    },
    "required": ["suggestions", "recommended", "recommendation"],
}

PROMPT = """You write uBlock Origin cosmetic filters. The user picked an element on {host}{path} and wants it hidden.

What the user wants: {goal}

Rules for your answer:
- Give 3 to 6 selectors, ordered best first. Rank by how well each fits the user's goal, then by how likely it is to survive the site's next redesign.
- Set "recommended" to the number (1 = first) of the one selector you would use, and "recommendation" to one short sentence on why it beats the others. Give the selector only, without the "{host}##" prefix; it is added for you.
- Each selector must match the picked element itself, the thing to hide, not something inside it. Follow the user's goal if it asks for something wider, such as every item of the same kind.
- Prefer what the site sets on purpose: data-testid, data-test-id, aria-label, role, stable ids, and class names that are real words.
- Class names that look hashed by a build tool change on every deploy. They are already removed from the HTML below; a "+N" in a class attribute counts the removed ones. Do not guess them.
- Avoid :nth-child and :nth-of-type unless nothing else works.
- :has-text() tests all the text inside an element, so an anchored regex such as /^Promoted$/ only fits an element whose whole text is the label. To key a card on a label inside it, use :has(… :has-text(/^Promoted$/)) or start at the label and use :upward().
- You may use uBlock's procedural operators when plain CSS has nothing steady to hold on to: :has-text(), :upward(), :matches-attr(), :min-text-length(), :has(), :not(), :xpath(). A text label such as "Promoted" or "Sponsored" is often the steadiest signal on generated sites.
- "why" is one short sentence: what the selector relies on, and what else on the page it would also hide.
- Use "note" only for something the user must know, such as the element not being separable from content they want.

The page, trimmed:

{context}
"""


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return None
    length = struct.unpack("@I", raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length))


def send_message(msg):
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def ask(msg):
    context = str(msg.get("context") or "")[:MAX_CONTEXT]
    if not context:
        return {"ok": False, "error": "no element context sent"}
    prompt = PROMPT.format(
        host=str(msg.get("host") or ""),
        path=str(msg.get("path") or ""),
        goal=str(msg.get("goal") or "").strip() or "Hide the picked element, and others of the same kind if that is clearly what it is.",
        context=context,
    )
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    env = {
        "PATH": CHILD_PATH,
        "HOME": str(HOME),
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        "USER": os.environ.get("USER", HOME.name),
        "CLAUDE_P_TIMEOUT": str(TIMEOUT_S),
    }
    try:
        proc = subprocess.run(
            [CLAUDE_P, "--output-format", "json", "--tools=", f"--json-schema={json.dumps(SCHEMA)}"],
            input=prompt,
            capture_output=True,
            text=True,
            cwd=str(WORK_DIR),
            env=env,
            timeout=TIMEOUT_S + 15,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"Claude took longer than {TIMEOUT_S}s"}
    except OSError as e:
        return {"ok": False, "error": f"could not run claude-p: {e}"}

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip()[:400]
        what = "timed out" if proc.returncode == 124 else f"exit {proc.returncode}"
        return {"ok": False, "error": f"claude-p {what}: {detail}"}
    try:
        envelope = json.loads(proc.stdout)
        out = envelope.get("structured_output") or json.loads(envelope.get("result") or "{}")
    except (ValueError, AttributeError):
        return {"ok": False, "error": "Claude's answer was not JSON"}

    suggestions = [
        {"selector": str(s.get("selector", "")).strip(), "why": str(s.get("why", "")).strip()}
        for s in out.get("suggestions", [])
        if isinstance(s, dict) and str(s.get("selector", "")).strip()
    ]
    reply = {"ok": True, "suggestions": suggestions}
    rec = out.get("recommended")
    if isinstance(rec, int) and 1 <= rec <= len(suggestions):
        reply["recommended"] = rec
        reply["recommendation"] = str(out.get("recommendation") or "")
    if out.get("note"):
        reply["note"] = str(out["note"])
    return reply


def main():
    msg = read_message()
    if not isinstance(msg, dict):
        send_message({"ok": False, "error": "no message received"})
        return
    try:
        send_message(ask(msg))
    except Exception as e:  # the browser only ever sees the reply, so never die silently
        send_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
