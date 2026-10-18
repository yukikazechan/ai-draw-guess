FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir -p /app/.local && chown -R node:node /app/.local
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=3211
USER node
EXPOSE 3211
VOLUME ["/app/.local"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm","start"]
