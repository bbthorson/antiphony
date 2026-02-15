"use strict";
/**
 * Shared Zod schemas and TypeScript types for Vox Pop (frontend & backend).
 *
 * @deprecated This file is deprecated. Please import from `shared/types/records` or `shared/types/views`.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
__exportStar(require("./types/records"), exports);
__exportStar(require("./types/views"), exports);
__exportStar(require("./types/blob"), exports);
__exportStar(require("./types/api"), exports);
__exportStar(require("./types/identity"), exports);
