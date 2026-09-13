# Production image for the arena API and the course server.
#
# Steel runs the browsers in its own cloud and we attach with
# chromium.connectOverCDP, so this image needs the playwright package but no
# browser binary — hence node:22-slim rather than a Playwright base image, and
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD on both stages.

FROM node:22-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
# tsconfig compiles src and test; both must be present for tsc to succeed.
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Overridden per app: the course app runs dist/src/course-server.js instead.
CMD ["node", "dist/src/server.js"]
