FROM node:22-alpine
# Optional thumbnailers: ImageMagick (incl. HEIC from iPhones) and ffmpeg for video posters.
RUN apk add --no-cache imagemagick imagemagick-heic ffmpeg
WORKDIR /app
COPY package.json mycloud.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir /data && chown node:node /data
ENV MYCLOUD_DATA=/data MYCLOUD_PORT=8080
VOLUME /data
EXPOSE 8080
USER node
ENTRYPOINT ["node", "mycloud.js"]
CMD ["serve", "--trust-proxy"]
