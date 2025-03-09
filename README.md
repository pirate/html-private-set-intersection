# Private Set Intersection for Web Content Anonymization

> How multiple parties can collaborate to anonymize web content that's interspersed with PII.

`#crawling`, `#scraping`, `#archiving`, `#digipres`, `#anonymization`, `#sanitization`, `#journalism`

See https://docs.sweeting.me/s/cookie-dilemma for background context.

#### HTML-Based Intersection

<img width="30%" alt="version_a" src="https://github.com/user-attachments/assets/a4662e25-788f-4688-8e1d-92ad8aafdc83" align="top"/> + <img width="30%" alt="version_b" src="https://github.com/user-attachments/assets/35b79cf8-7cd8-42de-8c1f-206c5faa30b6" align="top"/> ➡️  <img width="30%" alt="output" src="https://github.com/user-attachments/assets/cd18babd-afac-493c-b3e4-cd26923a958f" align="top"/>  

#### Image-Based Intersection
  
<img width="30%" alt="version_a" src="https://github.com/user-attachments/assets/dc2241ad-16f9-4d21-9fad-06d463349c20" align="top"/> + <img width="30%" alt="version_b" src="https://github.com/user-attachments/assets/bf3527a9-5716-4ccd-b7dc-334703c22981" align="top"/> ➡️  <img width="30%" alt="output" src="https://github.com/user-attachments/assets/7948ef5c-ff00-46d5-adeb-47debb859ad6" align="top"/>

## Pre-Requisites

Two nodes that have both independently archived some page (e.g. a facebook post) while logged in with their respective accounts (ideally around the same time, with the same browser, language, font settings, and light/dark mode).

Both WARC/HTML/PNG captures contain the main content they were trying to capture (photos, comments, etc.), but it's mixed in with unsharable PII specific to their individual accounts (e.g. their name, profile picture, email, session tokens, private notifications, recent DMs, etc.).

## The Goal

For the client to produce a final modified version of the content that contains only the intersection of the bytes that both nodes share, without ever revealing the cleartext to the server. The final copy should effectively be "anonymized" becuase it will exclude any bytes that are specific to either user (e.g. their PII). The client should be able to repeat this process to multiple servers, to further anonymize the content and should be able to be increasingly confident that nothing within will reveal their identity (hopefully) or their cookies/auth tokens (definitely).

This allows you to build a whole new digital ontology for human "perspective". You can start to cluster and intersect groups of people's perspective on websites and see how its content is rendered differently over time to different groups, without giving away the individual identity of everyone contributing to the public archive. This fixes the issue of traditional archiving tools struggling to archive private content (e.g. discord, facebook groups, whatsapp channels, etc.), because it requires login it used to force the archivist to burn their credentials everytime they share warcs. With good PSI tooling we can arrive at safe(r) anonymized versions and share them more freely, increasing the immediate and long term value of archiving.

The goal now becomes how do you manage identity in this system so that pairs of people can trust each other enough to go through the PSI process?
And ideally how do you *reward* them for doing that labor (without inviting copyright lawsuits).

Who pays for hosting of the non-anonymized and anonymized captures, and who responds to DMCA notices and subpoenas?

Also how do you collect, tag, curate, and swap bundles of this content between institutional servers (including [governments](https://archive-it.org/), [law enforcement](https://hunch.ly/), [lawyers](https://perma.cc/), [journalists](https://webrecorder.net/), [etc.](https://github.com/ArchiveBox/ArchiveBox)).

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

# find the intersection of images instead of text
./psi_image.js --server --reveal-intersection --file version_a.png
./psi_image.js --client localhost:5995 --reveal_intersection --file version_b.png
open ./psi_output.png

# try the demo UI WebRTC P2P PSI In-Browser
cd ui/
npm install
node server.js &
npm run dev
```

![Screenshot 2025-03-09 at 12 24 21 AM Private Set Intersection](https://github.com/user-attachments/assets/c047bc88-c847-4f70-ae65-5d3945aecfc4)


## Threat Model

Nodes should only attempt to anonymize with other *trusted* peers. The **output** of the PSI between two trusted peers is a result that is *then* safe to share with untrusted peers.
However the PSI process itself should never be attempted directly between *untrusted* peers, **especially for images**.

**How does it work? The hang-man attack.** An adversary can send 26 screenshots of the `facebook.com` homepage with the logged-in user's name in the upper left replaced with all `aaaaaaaaaaaaaaa`, `bbbbbbbbbbbbbbbb`, `ccccccccccccccc`, `ddddddddddddd`, etc. After only 26 screenshots they can see what every letter in every position is, because they're looking for matches in parallel! It's incredibly easy compared to bruteforcing the entire name at once. It's even worse if the malicoius peer has any inside knowledge as to who the other peer might be, as this narrows down the search space and they can just spot-check specific values. It gets harder the larger you make the tiles because eventually each tile contains multiple letters or words.

<img width="30%" alt="version_a" src="https://github.com/user-attachments/assets/1e12edcb-3c7a-4223-ab0f-4cad575c4e6a" align="top"/> + <img width="30%" alt="version_b" src="https://github.com/user-attachments/assets/c1a52757-b6c5-400e-9fac-6912e6f8a4b0" align="top"/> ➡️  <img width="30%" alt="output" src="https://github.com/user-attachments/assets/f4e7b1e6-11ba-4fd7-a071-7393e2ccab9e" align="top"/>

Mitigation: paranoid peers can increase their tile sizes from 5px to ~200px to cover entire words & sentences so that this attack is much harder.

#### Images

Adversary generates images that look like the info they want to test for (e.g. your name, email, profile picture, most recent notification timestamp, etc.), if you confirm the presence of that info, they know it must be you and they can send you to jail for whistleblowing, copyright violation, etc.

#### HTML

Adversary tests for words in the html e.g. first name, last name, email. Or they can convince you to archive a malicious page that embeds some text that they later test for, this allows definitely proving the identity of the archivist without a shadow of a doubt.

The solution to all of this is to just manually review the output, or have defense-in-depth using burner accounts for archiving and semi-automated review of PSI output before sharing.

## Further Reading

- https://docs.monadical.com/06IRHuDgS8CKYvvKr04g7w
- ⭐️ https://link.springer.com/chapter/10.1007/978-3-031-54776-8_4
- https://github.com/OpenMined/PSI
- https://github.com/mcoder/private-set-intersection
- https://github.com/OpenMined/PSI/blob/master/private_set_intersection/javascript/README.md#example
- https://eprint.iacr.org/2019/1255.pdf
- https://eprint.iacr.org/2023/030.pdf
- https://eprint.iacr.org/2021/728.pdf
