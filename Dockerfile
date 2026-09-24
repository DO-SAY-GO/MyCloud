# Pinned by digest: rebuilds are reproducible and a hijacked tag can't slip in. Bump deliberately.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
# Thumbnail converters (ImageMagick incl. HEIC, ffmpeg). In compose they only run in the isolated
# `thumbnailer` service, which has no data volume and no internet access.
RUN apk add --no-cache imagemagick imagemagick-heic ffmpeg
WORKDIR /app
COPY package.json mycloud.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir /data && chown node:node /data
ENV MYCLOUD_DATA=/data MYCLOUD_PORT=8080 MYCLOUD_TRUST_PROXY=1
VOLUME /data
EXPOSE 8080
USER node
ENTRYPOINT ["node", "mycloud.js"]
CMD ["serve"]
