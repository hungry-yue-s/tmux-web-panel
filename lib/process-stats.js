// Select the process collector for the current host platform.

import * as linux from './proc-stats.js';
import * as darwin from './darwin-stats.js';

const backend = process.platform === 'darwin' ? darwin : linux;

export const collectPids = (...args) => backend.collectPids(...args);
export const sampleTree = (...args) => backend.sampleTree(...args);
export const sampleNonTmuxByComm = (...args) => backend.sampleNonTmuxByComm(...args);
export const samplePidDetail = (...args) => backend.samplePidDetail(...args);
export const readDiskIo = (...args) => backend.readDiskIo(...args);
export const pruneStaleSamples = (...args) => backend.pruneStaleSamples(...args);
export const cpuCount = backend.cpuCount;
