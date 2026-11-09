# Changelog

Notable changes in each Agent Studio release, newest first. Settings → About shows this list, and
each GitHub release uses its section as release notes. `npm run release:version` adds the new
version's section from the commit subjects since the previous release; edit it before committing.
See [automatic updates](docs/UPDATES.md#publishing-a-release).

## 1.2.1 - 2026-11-09

### Changed

- Keep tool details and compacted context after a rewind or a fork: the next reply continues from
  a fork of the chat's session that ends at the last kept reply, instead of a new session built
  from the visible messages. When no session holds that reply, it starts from the saved messages
  and says so
- Keep a chat's session after Undo edits, and tell the next reply once that its files were
  restored

### Fixed

- Sign in to claude.ai with Continue with Google inside the app: the sign-in went to the browser
  and ended on a blank page
- Keep following a chat when its reply ends just after you send a message: the chat stopped short
  of its end

## 1.2.0 - 2026-11-04

### Added

- Turn the computer off once its chats finish: a power button beside Connections and Settings
  keeps it awake while it waits for this computer's replies, queued messages, chats going on
  after a usage limit and workflow runs, then counts down one minute with Cancel and Shut down
  now. Shutting down closes other apps without saving
- Pin chats: Pin in the chat toolbar or in a sidebar row's menu keeps a chat at the top of the
  Active or History tab it is in, on all your devices
- Bring chats back where you left them: a chat shown again after another chat or page returns to
  what you were reading, or to its end if you were following it, with what you opened in it
  still open. An artifact beside its chat keeps its tab and scroll positions, and a sub-agent's
  conversation its place

### Changed

- Publish Claude chats' pages to claude.ai right away, without waiting to be asked, and make
  later changes on top of the same artifact. Artifacts start private, and a page you ask to keep
  off claude.ai stays a file

### Fixed

- Keep Agent Studio's guidance in a Claude chat after its context is compacted: such a chat
  forgot how to show files, visuals, questions and pages, and listed its pictures' paths instead
  of showing them
- Show only the limits an account reports: a 5-hour or Weekly bar no longer reads Not reported
  on plans without that limit, in the composer, the Agent picker and Connections. Before an
  account's first reading they show Checking…
- Stop asking to turn off a plan mode that was never on: when Claude Code's safety checks refuse
  a command, such as `rm` on a variable path, the agent now hears what it hears in Claude's
  desktop app, and of plan mode only in plan mode
- Load a claude.ai artifact again beside the chat when a later reply changes it
- Give a page made from an Artifact type its card, and open it beside the chat

## 1.1.1 - 2026-10-31

### Changed

- Count a plan step from its start, so a chat's plan count in the sidebar and in its reply reads
  5/5 while the last step is in progress instead of 4/5. A finished reply still counts only the
  steps it completed

## 1.1.0 - 2026-10-30

### Added

- Open claude.ai artifacts inside the window on Windows, beside the chat or in the viewer, as the
  Claude app shows them, each Claude account in a claude.ai session of its own that you sign in
  to once
- Let screens run what they ask for at once: no approval to give, any MCP tool of the account's
  servers whether the screen declares it or not, and commands the page writes itself
- Keep a screen's context: a screen you opened stays loaded while you look at another chat,
  screen or page, and every action it runs is a job that goes on, shows its output as it arrives
  and keeps it, so a page that opens again after a reload, a restart or on your phone finds it.
  The screen's Jobs button shows each job's output, with Stop
- Reach WSL from a screen of a Windows chat, and Windows from one of a WSL chat: actions,
  commands and MCP calls can name where they run, so a screen calls the MCP servers signed in
  inside WSL, such as Linear, trying the accounts there until one has the server. Chats can list
  and try those servers before they build a page
- Give screens the clipboard, links that open in the browser, a model's answers as the screen's
  account, their saved values as they open, and chats they can send

## 1.0.3 - 2026-10-26

### Fixed

- Stop Start on the least used account from piling new chats onto one account until its 5-hour
  limit stops them all: each new chat now goes where it has the most of the 5-hour limit left,
  shared with the replies already running on each account, and the weekly limit decides only
  between accounts with about as much room, as before 1.0.0. Workflow steps and dynamic workflow
  agents without an account choose the same way

## 1.0.2 - 2026-10-23

### Added

- Play the audio files agents show you (MP3, M4A, AAC, WAV, FLAC, Ogg and WebM) in a player of
  the app's own, in the reply and larger in the file viewer, which keeps it playing as it opens
  and closes. A file that holds only sound, such as an MP4 without a picture, plays as audio

## 1.0.1 - 2026-10-23

### Fixed

- Bring the window back by itself when the engine that draws it (WebView2) fails, as it did when
  Windows ran out of memory: a window that went blank is built again at once, and one that kept
  showing the chat while saying Agent Studio stopped answering it is built again within a minute.
  Running replies carry on in the new window
- Keep the answer of a reply that finished while the window could not show it

## 1.0.0 - 2026-10-22

Agent Studio 1.0 adds workflows: static ones, graphs of steps that you and your agents draw, and
dynamic ones, where an orchestrator agent pursues a goal across chats, accounts, computers and
days. The window gets a new frame too, with the sidebar on the window itself and each page a card
beside it.

### Added

- Build static workflows from agent, message, condition, loop, wait, question, approval,
  notification, screen and workflow steps, and run them by hand, on a schedule, from a webhook, or
  when a chat's reply or another run ends, a computer comes online or a usage limit resets
- Give a dynamic workflow a goal: its orchestrator plans the work, starts agents on your computers
  and accounts, asks you when it needs to, and waits for usage limits to reset instead of stopping
- Follow each run in a live graph beside a numbered history of its steps, answer its questions
  there, and let another computer continue it when its own goes offline
- Switch between chats and workflows with the Agent and Workflow tabs in the sidebar; a new
  workflow starts as a chat with the agent that builds or runs it, Make a workflow turns a chat
  into one, and agents in any chat can list, edit and run workflows too
- Let screens call the MCP tools you allow, through the account of the chat that made them
- Open files in a viewer that covers the window, zoom images up to 1,024 times and 3D models
  towards the point under the pointer, and expand a comparison of images with a click
- Show the CSV and TSV tables, Excel workbooks, Markdown documents and MP4, MOV and WebM videos
  agents send, in the chat and in the viewer
- Zoom a 3D model or comparison in the chat with the wheel once you click it; a click elsewhere
  gives the wheel back to the chat
- Publish artifacts to claude.ai from Claude chats when you ask, with Claude Code's own Artifact
  tools, and open them from the reply
- Let a chat that a usage limit stopped continue by itself once the limit resets; its card says
  when, with Cancel
- Fade in new messages, pages and panels, give buttons a slight press, and cross-fade theme changes

### Changed

- Put the sidebar on the window, as in Linear, with the window's title and buttons beside it, and
  show chats, their side panels, Settings and Connections as cards, resized from the gap between
  them
- Make Start on the least used account prefer the account with the least of its week used while
  the accounts have room on their 5-hour limits
- Offer Run on more code blocks, now that chat agents name the shell of each command they give

### Fixed

- Keep replies running when the window reloads, which stopped every running reply and moved all
  chats to History; F5 and Ctrl+R no longer reload the window on Windows
- Stop Agent Studio from closing mid-reply when Windows runs short of memory: it now waits for
  memory, and saves large workspaces without copying them whole
- Answer the first message of a Claude chat after a restart, which failed when its CLI had left
  commands running, and stop Claude renewing a login in another chat from blocking Send and Retry
- Stop showing a notice each time a sign-in connects; the one asking you to finish signing in now
  leaves by itself
- Centre the usage limit card's words beside Switch account

## 0.11.0 - 2026-10-16

### Added

- Turn Fast mode on or off with Fast beside the message box, for the Claude and Codex models that
  offer it, or with `/fast`; when Claude says an account cannot use it, such as one without
  usage credits, the button turns orange and its hover says why
- Compare images and 3D models side by side, Free or Synced, so the panes move together; four
  files take two rows of two
- Pick the reasoning level on a slider, which the Reasoning dropdown opens
- Choose another account for a chat while its reply runs; the next message uses it
- Light 3D models flat or realistically as well as in the studio light, and pan them with the
  right button, Shift or two fingers
- Show HTML artifacts as cards instead of their code; agents preview a page before showing it,
  and pages can load pinned libraries and fonts from public CDNs
- Show each folder's icon in the Folder picker's list
- Close the image viewer and image previews with a click on the backdrop
- Keep each chat's artifact or sub-agent side panel open while other chats are shown

### Fixed

- Show the running sub-agents of a reply that took over or resumed them
- End replies that nothing runs any more, which kept their chats stuck as running
- Stop the phone Viewer from copying chats it only received, such as a chat moved to History on
  another computer
- Show textured FBX models in their painted colours

## 0.10.0 - 2026-10-14

### Added

- Snooze a chat until Agent Studio starts again: Snooze in the chat toolbar or in a chat's menu
  moves it to History, and the next time the app starts it waits at the top of the Active tab,
  where you can open it, snooze it again or close it
- Start new chats on the least used account, an option in Settings → New chats: each new chat
  starts on the account of its agent that has used the least of its 5-hour limit, or of its weekly
  limit without one, and you can leave accounts out of it
- Give each account a color of its own, which marks it in the Agent picker, in Connections and
  where a reply switched accounts; choose another in Manage account
- Show a steer as a message of your own, where the reply took it, dividing the reply there
- Show a day division where a chat continues on another day
- Show the agents' memory edits (Claude's memory, every CLAUDE.md and Codex's memories) in a
  Memories card of their own, beside Files edited
- Show each context compaction in Work history, where it happened among the reply's work
- Set up another server like the production VPS with `scripts/vps/setup.sh`

### Changed

- Stop a reply running in a long chat from freezing the window for half a second every few seconds

### Fixed

- Show what a reply writes after waiting for background work below the text it waited with
- Keep following the end of a chat when its window gets narrower on macOS, Linux and iPhone
- Keep replies running and images attaching when WebView2 restarts its network service, which made
  replies fail with "This conversation is already responding" until Agent Studio restarted

## 0.9.3 - 2026-10-11

### Added

- Discard an unsent draft from its row in the sidebar with the Move to history button chats have:
  a draft has no history to keep, so the button throws it away at once

### Fixed

- Show the Model picker properly on macOS and Linux, and in the Viewer on an iPhone, where each
  model's picture spread across its row, squeezing the names into a column of single letters,
  and the selected model's picture covered the Agent picker

## 0.9.2 - 2026-10-11

### Fixed

- Stop what a chat started when its chat goes to History or is deleted, as before 0.9.1: a chat on
  the VPS no longer leaves processes running behind it, and chats in WSL leave no files behind

## 0.9.1 - 2026-10-11

### Fixed

- Stop asking you to sign in to your Claude accounts again every morning. Checking an account
  started Claude Code renewing its expired login and ended it before the new login arrived, which
  signed the account out at its next renewal; the checks no longer renew, and Agent Studio never
  ends Claude Code in the middle of a renewal
- Stop the VPS from reading as offline. The desktop and the VPS sent their computer list back and
  forth on every sync, saving the whole workspace each time, until the VPS fell silent long enough
  for the relay to count it offline; it now stays online even while a long sync runs

## 0.9.0 - 2026-10-10

The VPS that hosts your relay is now a computer of your workspace: chats run on it while your
other devices are off, and its accounts sign in from your desktop or phone.

### Added

- Run chats on the VPS that hosts the relay. Each release installs and updates Agent Studio there by
  itself as a server, shown as VPS in Connections, the Computer picker and the sidebar: start a chat
  on it, browse its folders and use its accounts like any other computer's
- Sign in to the accounts of the VPS, or of another computer running this release, from any device.
  Open sign-in shows the page on your device, with Codex's code to enter there or a field for the
  code Claude's page shows; Add account, Connect on and Disconnect work for those computers too

### Fixed

- Remove every limit Agent Studio set on the size, number or length of your work: replies run on
  another computer no longer stop after 61 minutes, a Claude reply's edits after its hundredth are
  no longer missing from Files edited, and messages, images, files, tool results and uploads of any
  size go through; what remains is what the computer or the provider itself refuses

## 0.8.1 - 2026-10-09

### Fixed

- Stop the Viewer on a phone from closing itself while it loads a large workspace: it now keeps
  chats without the work their replies recorded, and reads a chat whole when you open it
- Stop a reload of the Viewer from marking replies still running on a computer as interrupted
- Stop chats from gaining "(conflict copy)" twins when a phone and a computer held a reply at
  different steps, or when a chat switched accounts on one of them

## 0.8.0 - 2026-10-08

Agent Studio now imports the chats Claude Code and Codex saved on this computer, signs in without a
terminal, shares settings, memories and chats with the Claude app, and runs chats on WSL folders
inside their distribution. Chats can also build lasting screens, and code blocks gain Copy and Run.

### Added

- Import the chats Claude Code and Codex saved on this computer and its WSL distributions, with
  their tool calls, files edited and images, from Settings → Workspace data → Import chats or
  /import. The first reply continues with the account that made the chat and leaves the original
  as it was
- Sign in to Claude Code and Codex from Connections with only the sign-in page in your browser,
  without a terminal
- Share settings, CLAUDE.md, memories, chats, plugins and skills with the Claude app and the
  terminal: a Claude account that uses this computer's context now works from the same files and
  keeps only its own login. On Windows, Agent Studio asks Windows once for permission to link two
  of those files
- Run chats on WSL folders inside their distribution, as the Claude app does, with its own CLIs and
  tools. Connections installs Claude Code or Codex in a distribution on request and adds this
  computer's accounts there by themselves: Codex accounts use their Windows login, and each Claude
  account signs in once inside the distribution
- Let chats build screens: lasting pages with their own interface and commands, listed in the
  sidebar's Screens tab and /screens, whose commands run only after you allow them
- Copy any code block in a reply, and run shell blocks in a console in the chat's folder
- Show a Claude question while it is being written
- Count a running chat's completed plan steps in its sidebar row
- Close a chat's phone alerts once you read it on another device
- Give each project folder its own icon, chosen once by a small model from the folder's name and
  the chat's first message
- Close an expanded Work history from its end with Collapse

### Changed

- Cut descriptions and explanatory text across the app down to labels, values, errors and warnings
- Moving a chat to History opens the next chat of the same project, or a new chat there after its
  last one

### Fixed

- Keep Claude chats past Claude Code's 30-day cleanup of old transcripts, and continue a chat whose
  transcript is gone from its saved messages instead of failing
- Stop everything a WSL chat started when you stop it, including commands and servers running on
  their own
- Say when Agent Studio stops answering its window, with Reload window, keep replies and Close from
  waiting on it, and record such freezes on this computer for diagnosis
- Stop relay connections from failing about one heartbeat in ten
- Show a running Claude reply's context from its first request, and keep it when the reply is
  stopped
- Keep a removed terminal login removed while the agent has other accounts
- Count chats waiting for your answer in the pending badge

## 0.7.0 - 2026-09-30

Sub-agents now open in a panel beside the chat, a chat's images and 3D models share one viewer, and
the Agent picker shows each account's usage and sign-in, so you can see which account to use next.

### Added

- Open a sub-agent's conversation in a panel beside the chat: its task, its messages among its own
  calls, the sub-agents it started and its result, kept whole however long. A running reply lists
  its sub-agents in its footer, with what each one is doing
- Show a chat's images and 3D models in one viewer that steps through all of them, with galleries
  for images sent together, zoom and pan, and 3D models at full detail. Other devices turn a large
  model through eight views of it
- Show each account's 5-hour and weekly usage in the Agent picker, and mark the accounts that need
  signing in; choosing one opens Connections at its Open sign-in
- Keep a reply that hit a usage limit open where it stopped, with the provider's line (such as
  "You've hit your session limit · resets 1:50pm") in a card instead of a failed answer, and Switch
  account to carry on with another account
- Send a message at once while a Claude reply only waits for background work: the message takes
  the reply over instead of waiting in the queue
- Go back to before a message with one click on Rewind here, which puts the message back in the
  composer to edit or send again
- Add a Jump to latest button, and glide down to a message you send from the end of a chat
- Show how long a running reply has run in its sidebar row, and mark a chat whose Claude monitors
  still run after its reply
- Record every call of a reply, instead of only the first 200

### Changed

- Keep a chat's CLI process until you move the chat to History, delete it or quit, instead of
  releasing it after fifteen idle minutes, so its next reply starts at once and its monitors keep
  running

### Fixed

- Keep Open sign-in available while replies run, and say why when it cannot open
- Keep a resumed sub-agent as one sub-agent, and stop showing one as failed because some of its
  own calls failed
- Open a chat at its end and keep following it, including replies that arrive from another device
- Show the model's version once in the Model dropdown, and give CLI default a mark as wide as the
  others

## 0.6.0 - 2026-09-28

Closing the window now keeps Agent Studio running in the system tray, Claude Code and Codex keep
themselves up to date, and chat images no longer travel inside every save and sync.

### Added

- Keep Agent Studio running in the system tray (the menu bar on macOS) when you close its window,
  so replies, alerts and chats started from your phone carry on. Click the tray icon to come back,
  or choose Quit Agent Studio in its menu; opening Agent Studio again shows the running window.
  Settings → Background turns this off
- Keep Claude Code and Codex up to date: the app runs their own updaters a minute after it starts
  and every six hours, with a switch for each in Settings → CLI updates and the installed version
  in Connections
- Show each model's version beside a small print of its line in the Model picker, the toolbar and
  every reply, and say under a reply's heading when it ran a different model from the one picked

### Changed

- Keep chat images once on each computer and once on the relay instead of inside the chats, so
  saving and syncing a conversation no longer carries its images

### Fixed

- Name Claude models for what the installed Claude Code runs, such as Opus 5.5, instead of
  promising "(latest)"
- Show a reply on your other devices as it is written again, not only at its plans, questions and
  end
- Stop a finished reply from flipping back to running, and an undone rewind from returning, on
  other devices
- Put the question itself in the alert for a reply's first question, instead of a generic line
- Alert for, and mark with a green dot, a reply that was still running on another computer when
  this app started, once it finishes
- Keep 3D models from going blank when a chat shows many of them, and name the reason when one
  cannot be opened, such as a compressed model
- Keep the files a reply shows in their numbered places, and open large tool results from another
  computer through the relay
- Let a Viewer tab open its saved copy after another tab removed a conversation
- Tell the model which fields to fix when it calls the image or visualization tools wrongly, so it
  retries instead of giving up

## 0.5.1 - 2026-09-27

### Fixed

- Show a sent 3D model with the textures inside it, instead of flat grey
- Deliver a reply's phone notification as soon as the reply ends, rather than one to three minutes
  later
- Stop a phone from ringing for a chat already opened on the computer that ran it

## 0.5.0 - 2026-09-26

Replies can now show you what they made — a render, a screenshot, a chart, even a 3D model — and
long conversations save and sync one chat at a time instead of the whole workspace.

### Added

- Let a reply show images from the computer it runs on, right where it explains them
- Open a glTF, GLB, OBJ, STL or FBX model the reply sends in a viewer you can turn and zoom, with
  its animations and a clip picker
- Mark a chat whose reply finished while you were elsewhere with a green dot until you open it
- Drag the conversation drawer open and closed from the left border of a phone screen
- Show each linked site's own icon before its link, in the app and in the Viewer
- Lead each edited file with the icon of its type
- Keep as many images in a conversation as you like, with up to sixteen of 16 MB in one message

### Changed

- Save and sync one conversation at a time, so typing and selecting stay smooth in a long chat
  while a reply streams
- Drop the 20 MB limit on the saved workspace
- Keep the Viewer's copy per conversation and resume its sync from the last checkpoint

## 0.4.1 - 2026-09-25

### Fixed

- Stop a short window from scrolling the title bar and sidebar off screen

## 0.4.0 - 2026-09-25

Chats no longer wait for each other, and notifications now say which chat finished and what it said.

### Added

- Run replies in several conversations at once, including chats with the same account, and stop each one on its own
- Send a chat's queued messages as soon as its reply finishes, even while another chat is open
- Title notifications with their chat and show the start of the reply, the text a stopped reply had reached, the error, or the question waiting for you
- Group History by app session, titled with the day and time Agent Studio started
- See what each running tool call is doing, such as Running `npm test`, before it folds into its group's count
- Move a chat to History from its sidebar row; moving the open chat opens the next Active one
- Keep every unsent new chat as its own draft in its folder, marked with a pen until you send or discard it

### Changed

- Remove the "An agent is responding in another conversation" notice; the sidebar shows which chats are replying
- Make Move to history the first action in the chat toolbar
- Mark chats with a running reply with a spinner and the open chat with a bar
- Show a spinner beside Responding, and a question icon and orange highlight while a reply waits for your answer
- Show sent images above the message bubble, with thumbnails that leave out file names
- Draw the Stop response icon as an outline like the other icons

### Fixed

- Show desktop notifications for a later question in a reply and for MCP input requests
- Start new chats with the agent and account you last chose, not the account of the reply that started last
- Stop "Cannot finish workspace save" errors when Agent Studio starts
- Give every chat started at the same time a generated title, not only the first two
- Return a queued message to the composer when it no longer fits the workspace, instead of dropping it
- Keep the open chat in place when a reply finishes in another chat

## 0.3.0 - 2026-09-25

Tool calls now show what ran and what came back, and each reply keeps its plan and background work in its footer row.

### Added

- See the command each tool call ran and what it returned: output with its exit code, standard error, numbered file contents, search matches, web page text and connected tool results
- See the images an agent viewed or a tool returned, and open them full size
- Give tool calls and groups icons for what they do, such as the Git logo for git commands and a flask for test runs
- Show an edit's own diff inside its tool call
- Keep complete tool outputs on the computer that ran the reply until their chat is deleted, without adding them to synced history
- Show a reply's plan, workflow runs and background work as toggles beside its elapsed time
- Count every kind of action in Work history groups, such as Read 3 files and ran 2 commands
- Show the app version and this changelog in Settings → About

### Changed

- Save and load large workspaces without blocking the window
- Look up accounts and chats faster in large workspaces

### Fixed

- Name new conversations with generated titles again
- Open Connections without freezing in large workspaces
- Keep chats responsive while the relay has nothing new
- Keep long chats responsive while selecting text
- Keep following background work after its reply ends
- Mark native workflow runs with a workflow icon in the reply row

## 0.2.1 - 2026-09-24

### Fixed

- Keep the Viewer's workspace copy in IndexedDB, so signing in works after a workspace outgrows browser local storage

## 0.2.0 - 2026-09-23

The first published release. Installed desktop apps update themselves from this version on.

### Added

- Chat with Claude, Codex and Gemini through the CLIs and subscriptions already on your computers
- Connect several accounts per agent with separate profiles, and switch accounts between replies
- Run chats on other computers and managed WSL distributions through a private relay workspace
- Follow and answer chats from the installable Viewer app on phones and in browsers
- Get desktop notifications with the Agent Studio chime, mobile push alerts, and pending chat badges
- Review each reply's reasoning, tool calls, sub-agents, hooks, and plans in Work history
- See the files each reply edited, rewind conversations, and undo recorded file edits
- Queue, steer, and stop running replies, fork conversations, and compact their context
- Answer agent questions, approve plans in Plan mode, and fill in MCP forms inside the chat
- Track 5-hour, weekly, and context usage with pace guides, credits, and estimated spend
- Manage MCP servers, plugins, skills, and hooks from Model context
- Use slash commands, skills, file and app mentions, templates, and images in the composer
- Preview HTML and SVG artifacts and interactive visualizations beside the chat
- Keep unsent drafts per chat and folder across restarts
- Choose a Dark, Light, or System appearance
- Install signed desktop updates from GitHub Releases in the background
