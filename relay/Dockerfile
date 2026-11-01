FROM node:24-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY svelte.config.js vite.config.js tsconfig.json CHANGELOG.md ./
COPY src ./src
COPY relay/artifact-preview.ts ./relay/
COPY static ./static
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY relay/server.ts relay/start.ts relay/web.ts relay/icons.ts relay/downloads.ts relay/sessions.ts relay/push.ts relay/images.ts relay/workflows.ts relay/workspaces.ts relay/manage.ts relay/artifact-preview.ts ./relay/
COPY src/lib/compaction.ts src/lib/domain.ts src/lib/fleet.ts src/lib/sync.ts src/lib/activity.ts src/lib/reasoning.ts src/lib/images.ts src/lib/plans.ts src/lib/workflows.ts src/lib/visualizations.ts src/lib/artifact-records.ts src/lib/questions.ts src/lib/steering.ts src/lib/file-changes.ts src/lib/input-templates.ts src/lib/notifications.ts src/lib/installation.ts src/lib/spend.ts src/lib/artifact-preview.html ./src/lib/
COPY --from=frontend /app/build ./build
COPY src/lib/mcp.ts ./src/lib/
COPY src/lib/plugins.ts ./src/lib/
COPY src/lib/proposed-plans.ts ./src/lib/
COPY src/lib/elicitations.ts ./src/lib/
COPY src/lib/live-usage.ts ./src/lib/
COPY src/lib/mentions.ts ./src/lib/
COPY src/lib/structured-output.ts ./src/lib/
COPY src/lib/claude-options.ts ./src/lib/
COPY src/lib/claude-instructions.ts ./src/lib/
COPY src/lib/app-sessions.ts ./src/lib/
COPY src/lib/folder-icons.ts ./src/lib/
COPY src/lib/account-colors.ts ./src/lib/
COPY src/lib/snoozes.ts ./src/lib/
COPY src/lib/pins.ts ./src/lib/
COPY src/lib/sent-files.ts ./src/lib/
COPY src/lib/tool-output.ts ./src/lib/
COPY src/lib/usage-limits.ts ./src/lib/
COPY src/lib/question-drafts.ts ./src/lib/
COPY src/lib/screens.ts ./src/lib/
COPY src/lib/published-artifacts.ts ./src/lib/
COPY src/lib/light-chats.ts ./src/lib/
COPY src/lib/json-equal.ts ./src/lib/
COPY src/lib/workflow-model.ts ./src/lib/
COPY src/lib/workflow-store.ts ./src/lib/
ENV AGENT_STUDIO_RELAY_HOST=0.0.0.0 AGENT_STUDIO_RELAY_PORT=4317 AGENT_STUDIO_RELAY_DATA=/data
# Node sizes its heap from the container's memory, stopping well before it; let the container's
# own memory be the limit.
ENV NODE_OPTIONS=--max-old-space-size=1048576
USER node
EXPOSE 4317
CMD ["node", "relay/start.ts"]
