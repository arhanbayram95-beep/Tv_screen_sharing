'use strict';

/*
 * Generates a self-signed cert covering every LAN address this machine has.
 *
 * A phone will not open its camera on an http:// page, so sending from a phone
 * needs TLS. Chrome ignores the certificate's Common Name entirely and matches
 * only subjectAltName, so the SAN list below is the part that matters - a cert
 * with just a CN produces ERR_CERT_COMMON_NAME_INVALID with no way past it on
 * some Android builds.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function lanAddresses() {
  const out = [];
  const interfaces = os.networkInterfaces();
  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((entry) => {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    });
  });
  return out;
}

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

function buildConfig(addresses) {
  const alt = ['DNS.1 = localhost', 'IP.1 = 127.0.0.1'];
  addresses.forEach((ip, i) => alt.push('IP.' + (i + 2) + ' = ' + ip));
  return [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3_req',
    'prompt = no',
    '',
    '[dn]',
    'CN = TV Screen Share',
    '',
    '[v3_req]',
    'basicConstraints = CA:TRUE',
    'keyUsage = digitalSignature, keyEncipherment, keyCertSign',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
  ].concat(alt).join('\n') + '\n';
}

/** Returns { certPath, keyPath, addresses, created }. */
function ensureCert(dir) {
  const certDir = dir || path.join(__dirname, '..', 'certs');
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');
  const addresses = lanAddresses();

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath, addresses, created: false };
  }
  if (!hasOpenssl()) {
    throw new Error(
      'openssl was not found on PATH.\n' +
      '  Install it, or supply your own certificate with TLS_CERT and TLS_KEY.\n' +
      '  Windows: openssl ships with Git for Windows (use Git Bash).'
    );
  }

  fs.mkdirSync(certDir, { recursive: true });
  const configPath = path.join(certDir, 'openssl.cnf');
  fs.writeFileSync(configPath, buildConfig(addresses));

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      // Safari refuses certificates valid for more than 825 days.
      '-days', '825',
      '-keyout', keyPath,
      '-out', certPath,
      '-config', configPath,
      '-extensions', 'v3_req',
    ], { stdio: 'ignore' });
  } finally {
    try { fs.unlinkSync(configPath); } catch (err) { /* best effort */ }
  }

  return { certPath, keyPath, addresses, created: true };
}

module.exports = { ensureCert, lanAddresses };

if (require.main === module) {
  try {
    const result = ensureCert();
    console.log(result.created ? 'Created:' : 'Already present:');
    console.log('  ' + result.certPath);
    console.log('  ' + result.keyPath);
    console.log('Valid for: localhost, 127.0.0.1' +
      (result.addresses.length ? ', ' + result.addresses.join(', ') : ''));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
