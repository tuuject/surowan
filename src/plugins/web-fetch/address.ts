import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { WebFetchError } from './shared.ts';

const blockedAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4');
}
// IPv4-mapped ::ffff:0:0/96 is deliberately absent: BlockList matches IPv4 lookups
// against it, which would block every IPv4 address. The 2000::/3 check in
// isPublicAddress already rejects mapped addresses.
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  // Transition prefixes embed an IPv4 destination (6to4 in 2002::/16, Teredo in
  // 2001::/32) that a host with a matching tunnel route would reach without the
  // IPv4 deny list ever seeing it.
  ['2001::', 32],
  ['2002::', 16],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6');
}

const proxySyntheticAddresses = new BlockList();
proxySyntheticAddresses.addSubnet('198.18.0.0', 15, 'ipv4');

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface AddressPolicy {
  readonly allowAll: boolean;
  readonly allowProxySynthetic: boolean;
}

export type ResolveHostname = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export async function resolveAllowedAddress(
  hostname: string,
  resolver: ResolveHostname,
  policy: AddressPolicy,
): Promise<string> {
  const family = isIP(hostname);
  const addresses: readonly ResolvedAddress[] =
    family === 0 ? await resolver(hostname) : [{ address: hostname, family } as ResolvedAddress];
  if (addresses.length === 0) {
    throw new WebFetchError('dns_error', 'Hostname resolved to no addresses');
  }
  if (
    !policy.allowAll &&
    addresses.some(
      (entry) =>
        !isPublicAddress(entry.address, entry.family) &&
        !(
          policy.allowProxySynthetic &&
          family === 0 &&
          entry.family === 4 &&
          proxySyntheticAddresses.check(entry.address, 'ipv4')
        ),
    )
  ) {
    throw new WebFetchError('blocked_address', 'Hostname resolves to a non-public address');
  }
  return addresses[0]?.address ?? '';
}

function isPublicAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) {
    return isIP(address) === 4 && !blockedAddresses.check(address, 'ipv4');
  }
  const firstGroup = Number.parseInt(address.split(':', 1)[0] ?? '', 16);
  return (
    isIP(address) === 6 && firstGroup >= 0x2000 && firstGroup <= 0x3fff && !blockedAddresses.check(address, 'ipv6')
  );
}

export async function defaultResolveHostname(hostname: string): Promise<readonly ResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.flatMap((entry) =>
    entry.family === 4 || entry.family === 6 ? [{ address: entry.address, family: entry.family }] : [],
  );
}
