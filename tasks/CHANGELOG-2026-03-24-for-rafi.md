# What Changed in Claude Peers Today (March 24, 2026)

Hey Rafi — here's a plain-English rundown of everything that was added to the Claude Peers system today. No code jargon, just what it does and why it matters for us.

---

## What is Claude Peers?

Claude Peers lets multiple Claude Code sessions on the same computer (or eventually the same network) find each other and talk to each other in real time. Think of it like a group chat between your AI assistants — if you have Claude working on three different projects, they can coordinate, ask each other questions, and hand off tasks.

---

## New Features Added Today

### 1. Session Names

**Before:** Each session was just a random ID like "abc12345". You had no idea which session was which.

**Now:** Sessions can have human-readable names like "Rafi-Claude-Cloning-Project" or "ADD_MORE_2_CC". When you list who's online, you see names instead of gibberish.

### 2. Security / Password Protection

**Before:** Any program on your computer could read messages and pretend to be a session. No protection at all.

**Now:** The system generates a secret password file the first time it starts up. Every request has to include this password or it gets rejected. Think of it like a private group chat that requires an invite code. You can also rotate the password if you ever need to.

### 3. Message Types

**Before:** Every message was just plain text. A question looked the same as a task handoff looked the same as a status update.

**Now:** Messages have categories:
- **Text** — Regular chat message (same as before)
- **Query** — A question expecting an answer
- **Response** — A reply to a question
- **Handoff** — "Hey, I need you to take over this task" with structured details
- **Broadcast** — An announcement to everyone

Each message can also carry structured data (like a list of files to work on) and can be threaded (reply to a specific earlier message).

### 4. Broadcast Messages

**Before:** You could only send messages one-at-a-time to a specific session.

**Now:** You can broadcast to everyone at once. "Hey all sessions in this repo, deployment is about to happen" — and every active session gets that message instantly.

### 5. Auto-Summary on Startup

**Before:** When a new session started, other sessions had no idea what it was working on unless someone manually set a description.

**Now:** Every session automatically generates a summary when it starts, like:
- "[claude-peers-mcp:main] Working in /home/riche/MCPs/claude-peers-mcp"
- "[my-project:feature-branch] 3 in-progress tasks"

Other sessions can see this immediately — no manual step needed.

### 6. Message Delivery Guarantee

**Before:** If a message was sent but the notification failed, the message was silently lost. You'd never know.

**Now:** Two-step delivery — the message is only marked as "delivered" after the recipient confirms they got it. If delivery fails, it retries automatically on the next check. Messages don't get lost anymore.

### 7. Dead Session Detection

**Before:** If a session crashed, its messages would pile up in a queue forever.

**Now:** Before sending a message, the system checks if the recipient is actually still running. If their process is dead, you get an immediate error: "That session isn't running anymore" instead of your message disappearing into the void.

### 8. Rate Limiting and Message Size Limits

**Before:** No limits on anything. A runaway script could spam thousands of messages.

**Now:**
- Maximum 60 messages per minute (prevents spam)
- Maximum 10KB per message (prevents giant payloads from clogging things)
- Old delivered messages automatically cleaned up after 7 days

### 9. Comprehensive Logging

**Before:** No way to see what messages were being sent between sessions.

**Now:** All messages (sent and received) are logged with timestamps. You can watch the conversation in real time with a simple command. Great for debugging when sessions aren't communicating as expected.

---

## What's Coming Next

### LAN Networking (The Big One)

Right now, Claude Peers only works on a single computer. The plan is to make it work across your local network — so your Claude sessions and my Claude sessions could talk to each other even though we're on different machines. This needs security research first (encryption, authentication over the network, etc.) so it's not rushed.

### Other Small Items
- **hcom bridge** — Connect Claude Peers to the hcom system (another multi-agent communication tool)
- **clink integration** — When PAL spawns new AI agents, automatically register them with Claude Peers

---

## By the Numbers

- **38 commits** today
- **75 automated tests** (started the day with 0 for the server, 19 for the broker)
- **5 major features** shipped
- **6 detailed design documents** written for upcoming features
- **3+ Claude sessions** coordinating via the tool itself to build it (meta!)

---

## Why This Matters

Claude Peers is the backbone for multi-session AI collaboration. Instead of running one Claude at a time and manually copying context between sessions, multiple Claudes can:
- See who else is working and on what
- Ask each other questions directly
- Hand off tasks when one session's context overflows
- Broadcast status updates to the whole team

Today's changes took it from a basic prototype to a hardened, secure, well-tested communication system ready for real daily use.
