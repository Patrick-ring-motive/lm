// realtime-permissions.js — Wix Velo backend file.
// Must be named exactly "realtime-permissions.js" in the backend/ folder.
// Grants read access to the "completions" channel for all visitors.

import { permissionsRouter } from "wix-realtime-backend";

// Allow anyone (visitor, member, admin) to subscribe to completions channels.
permissionsRouter.default((channel, subscriber) => {
    return { read: true };
});

export function realtime_check_permission(channel, subscriber) {
    return permissionsRouter.check(channel, subscriber);
}
