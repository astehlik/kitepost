FROM nginxinc/nginx-unprivileged:1.29-alpine
ENV APP_URL=app/
COPY docker/site/default.conf.template /etc/nginx/templates/default.conf.template
COPY site/ /usr/share/nginx/html/
EXPOSE 8080
