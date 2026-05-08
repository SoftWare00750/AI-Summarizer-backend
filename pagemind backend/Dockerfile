# Use the official Playwright image as it has all browser dependencies
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install ONLY the chromium browser binary (dependencies are already in the base image)
RUN npx playwright install chromium

# Copy the rest of the source code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
