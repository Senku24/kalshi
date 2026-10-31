FROM oven/bun
WORKDIR /apps
COPY . .
RUN bun install
EXPOSE 5000
CMD ["bun", "/apps/api/index.ts"]

