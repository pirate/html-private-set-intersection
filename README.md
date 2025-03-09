# Private Set Intersection for Web Content Anonymization

> How multiple parties can collaborate to anonymize web content that's interspersed with PII.

`#crawling`, `#scraping`, `#archiving`, `#digipres`, `#anonymization`, `#sanitization`, `#journalism`

See https://docs.sweeting.me/s/cookie-dilemma for background context.

#### HTML-Based Intersection

<img width="30%" alt="version_a" src="https://github.com/user-attachments/assets/a4662e25-788f-4688-8e1d-92ad8aafdc83" align="top"/> + <img width="30%" alt="version_b" src="https://github.com/user-attachments/assets/35b79cf8-7cd8-42de-8c1f-206c5faa30b6" align="top"/> ➡️  <img width="30%" alt="output" src="https://github.com/user-attachments/assets/cd18babd-afac-493c-b3e4-cd26923a958f" align="top"/>  

#### Image-Based Intersection
  
<img width="30%" alt="version_a" src="https://github.com/user-attachments/assets/dc2241ad-16f9-4d21-9fad-06d463349c20" align="top"/> + <img width="30%" alt="version_b" src="https://github.com/user-attachments/assets/bf3527a9-5716-4ccd-b7dc-334703c22981" align="top"/> ➡️  <img width="30%" alt="output" src="https://github.com/user-attachments/assets/7948ef5c-ff00-46d5-adeb-47debb859ad6" align="top"/>

## Pre-Requisites

Two nodes that have both independently archived some page (e.g. a facebook post) while logged in with their respective accounts.

Their WARC/HTML captures contain the main content they were trying to capture (photos, comments, etc.), but it's mixed in with unsharable PII specific to their individual accounts (e.g. their name, profile picture, email, session tokens, private notifications, messages, etc.).

## The Goal

For the client to produce a final modified version of the content that contains only the intersection of the bytes that both nodes share, without ever revealing the cleartext to the server. The final copy should effectively be "anonymized" becuase it will exclude any bytes that are specific to either user (e.g. their PII). The client should be able to repeat this process to multiple servers, to further anonymize the content and should be able to be increasingly confident that nothing within will reveal their identity.

## Quickstart

```bash
git clone https://github.com/pirate/html-private-set-intersection.git
cd html-private-set-intersection

# make sure bun is installed
curl -fsSL https://bun.sh/install | bash

# install the npm dependencies
npm install

# on node1 run the server
./psi.js --server --file test2a.html --reveal-intersection

# on node2 run the client
./psi.js --client node1.local:5995 --file test2b.html --reveal-intersection --highlight

# on node2 save the output as redacted html that can be viewed in a browser
./psi.js --client node1.local:5995 --file test2b.html --reveal-intersection --redact > out.html
open out.html
```

## Threat Model

Nodes should only attempt to anonymize with other *trusted* peers. While the PSI does help anonymize content most of the time, a malicious peer could contruct false images or HTML and use it to gradually reverse-engineer any content you send them.

Want to de-anonymize another node with one screenshot? Use the hang-man attack. Send them 26 screenshots of the `facebook.com` that you construct by DOM editing the page to replace the logged in user's name with `aaaaaaaaaaaaaaa`, `bbbbbbbbbbbbbbbb`, `ccccccccccccccc`, `ddddddddddddd`, etc. you only need to do one for each letter because you'll start to see all matching letter immediately (like hangman but faster).

<img width="30%" alt="version_a" src="https://github.com/user-attachments/assets/1e12edcb-3c7a-4223-ab0f-4cad575c4e6a" align="top"/> + <img width="30%" alt="version_b" src="https://github.com/user-attachments/assets/c1a52757-b6c5-400e-9fac-6912e6f8a4b0" align="top"/> ➡️  <img width="30%" alt="output" src="https://github.com/user-attachments/assets/f4e7b1e6-11ba-4fd7-a071-7393e2ccab9e" align="top"/>

Mitigation: what if the server only releases a random subset of tiles, and only after you match a few and send back a proof that you have the original pixels does the server let you PSI test the next range. That way the server can at least try to block attempted fishing from malicious peers trying to reverse engineer content or de-anonymize their own captures.

## Further Reading

- https://docs.monadical.com/06IRHuDgS8CKYvvKr04g7w
- ⭐️ https://link.springer.com/chapter/10.1007/978-3-031-54776-8_4
- https://github.com/OpenMined/PSI
- https://github.com/mcoder/private-set-intersection
- https://github.com/OpenMined/PSI/blob/master/private_set_intersection/javascript/README.md#example
- https://eprint.iacr.org/2019/1255.pdf
- https://eprint.iacr.org/2023/030.pdf
- https://eprint.iacr.org/2021/728.pdf
