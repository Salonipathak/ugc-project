import * as Sentry from "@sentry/node";

Sentry.init({
    dsn: "https://1d4cd19adff7d89d3bd7759bba4fdfbc@o4511378673106944.ingest.us.sentry.io/4511378676580352",
    sendDefaultPii: true,
});
