# Microsoft Playwright resmi imaji — Chromium ve tum sistem bagimliliklari hazir gelir.
# Sürum, package.json'daki playwright versiyonu ile eşleşmeli (^1.57.0).
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# Bagimliliklari onbellege almak icin once package dosyalari
COPY package.json package-lock.json ./

# devDependencies dahil yukle (vite build icin gerekli)
RUN npm ci --include=dev

# Uygulama kaynaklarini kopyala
COPY . .

# Frontend'i build et
RUN npm run build

# Calisma zamani ortam degiskenleri
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

# Azure Container Apps targetPort ile bu portu eslestirir
EXPOSE 8080

# Sunucuyu calistir
CMD ["node", "server/index.js"]
