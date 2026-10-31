FROM ubuntu:latest
RUN curl -fsSL https://bun.com/install | bash
COPY . .
RUN bun install
CMD ["bun", "index.ts"]

