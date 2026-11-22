FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3456
ENV USE_LIGHT_PDF=true

EXPOSE 3456

CMD ["node", "server.js"]
