# html-private-set-intersection


```bash
git clone https://github.com/pirate/html-private-set-intersection.git
cd html-private-set-intersection

npm install

# on node1
node psi.js --server --file test2a.html --reveal-intersection

# on node2
node psi.js --client node1.local:5995 --file test2b.html --reveal-intersection --highlight
```
