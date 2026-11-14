Agent board shows the agents of the current project, across its workspaces, as a live tree of cards, one card per Paseo agent. Agents started by another agent sit to the right of their parent, joined by an arrow, and pressing the arrow shows the instructions the parent sent. Open it as a workspace panel or with **Open agent board** in the Command Center.

## Setup

Agent board needs Paseo 0.15.3 or later and no account or settings of its own. Card titles, the **Now** line and instruction summaries come from Claude Haiku through the Claude Code CLI on the daemon machine, so Claude Code must be installed and signed in there for them. The plugin is tested on macOS. On other systems the Claude Code call may fail, and cards then fall back to Paseo's titles and the latest activity.

The switch in the header (**Haiku summaries on** or **Haiku summaries off**) turns summaries on or off for every board on the host. While it is off, the plugin makes no Claude calls, and the rest of the board works the same.

## Cards

- Each card shows the provider icon (Claude's mark, or the OpenAI mark for Codex), the role or provider, the agent profile it matches (icon and name in the profile's color), the status, a short title, and colored tags for the model, effort and permission mode. Effort runs from green (low) to red (max). Permission modes are red for bypass or full access, amber for auto modes, blue for plan and green for modes that ask.
- Under the tags, a bar shows how full the agent's context window was after its last turn, with the percentage and token counts. It turns amber from 50% and red from 80%.
- Claude Haiku writes the title and the **Now** line (**Last** when the agent is not running) from the agent's last 150 timeline items. The title (up to 40 characters) says what the session works on, and **Now** (up to 60 characters) says what the agent is actually doing. Until the first summary arrives, the card shows Paseo's title and the latest tool call, answer or thought. After that, a card keeps its last summary until the next one replaces it.
- While an agent runs, its latest tool call shows live, in the **Tool** line once a summary fills **Now**, and in **Now** itself before that. The **Step** line shows the current step of the agent's todo list when it has one.
- While an agent compacts its context, its status reads **Compacting** in purple and the **Compact** line reads **Compacting the conversation** until the compaction ends.
- A subagent that an agent starts inside its own session, such as one from Claude's Agent tool, gets a smaller card under that agent, joined by an arrow. The card shows **Subagent** with the subagent type, the task description, Paseo's line of model, effort and tokens, and **Working**, **Done**, **Error** or **Stopped**. Pressing it opens Paseo's own tab for the subagent on Paseo versions whose plugin navigation can open one, and otherwise shows the subagent's conversation over the board: the messages it was given, its answers, its tool calls and errors, refreshed every 2 seconds while it works. **Open parent agent** in that view opens the agent that started it. Pressing its arrow lists the messages the subagent was given. Running subagents and the ones started since the agent's latest prompt show, and older ones show with **Ended agents (24h)** on.
- The header counts all visible agents, the working ones, and the ones that need attention because of a pending permission or an error. Subagents are not counted.

## Arrows and instructions

- Side by side, the arrow joins the facing sides of the two cards at their vertical middle. With one card above the other, it leaves the parent's bottom (or top) center and enters the child's top (or bottom) center. While the child runs, the arrow turns amber and dots travel along it toward the child.
- Pressing an arrow, or the button in its middle, opens an **Instructions sent** box over that button. It lists the messages the parent agent sent the child, oldest first, read from the child's whole timeline. **First instruction** is the delegation and the follow-ups come after it. Your own prompts to the child are not listed.
- With summaries on, each instruction shows Haiku's goal and up to five main points, and **Show original** unfolds the text as sent. With summaries off, the original shows. The box header names both agents, by their summarized titles when summaries are on.
- Pressing anywhere on the board outside the box closes it. The buttons and the box sit above the cards. On desktop and web, the box keeps its size at any zoom and opens on the side of the button with more room, so it stays inside the board.

## Layout and navigation

- The **Group by workspace** switch (on by default) stacks each workspace's graphs together and draws a dashed, lightly tinted box around them, with the workspace name and its labels in their Paseo colors on top. Boxes follow cards you drag, and dragging a box moves every card of its workspace together.
- Drag a card to move it, and press it briefly to open the agent. Hold Shift while dragging to snap the card to another card's left or top edge, one tree gap beside, above or below a card, or else to a 20px grid. Positions are saved per agent on the host, so they stay after the tab is closed. **Reset layout** puts the moved cards back in the tree layout.
- Scroll or swipe to move around the board in any direction (Shift + wheel moves sideways). Zoom from 25% to 150% around the pointer with Ctrl or ⌘ + scroll, or a trackpad pinch. In the mobile app the board scrolls instead and does not zoom. Position and zoom reset when the tab reopens.
- ⌘Z or Ctrl+Z, with the pointer over the board, undoes the last card move, workspace move or layout reset, up to 50 steps.
- The **Ended agents (24h)** switch also shows agents that were closed or archived in the last 24 hours, dimmed with a dashed border.
- The crosshair on a card highlights that agent with its ancestors and descendants and dims the rest, and the eye button hides that agent with its descendants. **Clear highlight** in the header removes the highlight, and another header button shows the hidden agents again. These view settings are kept per tab.

## Languages and themes

The board follows the app language and is available in English, Korean and Simplified Chinese. Other app languages show English. Haiku writes summaries in the app language, with about half the characters in Korean, Japanese and Chinese, and a new app language gets new summaries.

On light themes, cards, arrow buttons and the instruction box keep the dark Ghostty colors, while the background, header and workspace boxes follow the theme.

## Data access

The board reads the project's agents, their timelines, the workspaces and the host's agent profiles through Paseo. Card positions and the summary switch are saved in the plugin's host settings, and the other view settings in the tab.

Summaries run Claude Code in print mode (`claude -p`) with the Haiku model on the daemon machine, from a temporary folder, with no tools, settings, MCP servers or saved session. They use your Claude usage. Each card summary sends the agent's Paseo title and up to about 6,000 characters of its newest activity to Anthropic through Claude Code. That activity is prompts and instructions (up to 400 characters each), agent answers (up to 300), tool calls with their shell commands, short file paths, search queries and URLs (up to 200), todo items, and errors (up to 200). A running agent is summarized at most once a minute, and a stopped one only when its timeline has changed since the last summary.

Opening an instruction box with summaries on also sends each listed instruction, up to its first 8,000 characters, for a summary. This happens once per instruction text and app language while the plugin runs, and a failed call is tried again the next time the box shows that instruction. At most two Claude calls run at once, and each one stops after 60 seconds. Summaries are kept in memory only and are lost when the plugin reloads.

For subagent cards, the plugin's server connects to the daemon on its own machine, at the `daemon.listen` address in the Paseo home's `config.json`, and reads the subagents of the shown agents, the messages each subagent was given, and the whole conversation of a subagent whose conversation you open. It reads them every 2 seconds while an agent or a subagent runs, and every 20 seconds otherwise.

To color workspace labels, the plugin reads Paseo's label file, `projects/workspace-labels.json` in the Paseo home folder (`~/.paseo` unless `PASEO_HOME` is set), on the daemon machine. It uses only each label's name and color. If the file cannot be read, labels are gray.

## Limits

- Paseo does not record which profile started an agent, so a card shows the profile whose provider and fixed settings (model, permission mode, effort) all equal the agent's current ones. An agent set up by hand like a profile shows that profile, and one whose mode or effort changed afterwards shows none.
- Closed and archived agents are hidden unless **Ended agents (24h)** is on.
- Paseo's plugin API has no subagent list, so the plugin connects to the daemon on its own machine for subagent cards. A daemon that needs a password or listens on a socket shows no subagent cards.
- New agents take their tree position and can overlap a card you moved.
- Dragging is meant for desktop. On touch devices it can conflict with scrolling.
