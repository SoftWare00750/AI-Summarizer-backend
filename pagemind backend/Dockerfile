FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install
# We install just the browser. No --with-deps needed!
RUN npx playwright install chromium

COPY . .

EXPOSE 3000
CMD [ "npm", "start" ]
