module.exports = {
  apps: [{
    name: "cdpx",
    script: "server.ts",
    cwd: "./web",
    interpreter: process.env.HOME + "/.bun/bin/bun",
    watch: false,
    autorestart: true,
    max_restarts: 10,
    env: {
      NODE_ENV: "production",
    },
  }],
};
