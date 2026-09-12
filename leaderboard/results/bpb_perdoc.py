# -*- coding: utf-8 -*-
import json, math, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
docs=[json.loads(l)["text"] for l in open("C:/tmp/heldout_bpb_sample.jsonl",encoding="utf-8")]
models={"GoLLeM-45M":"SlayerLab/GoLLeM-45M-PL","GoLLeM-110M-v2":"SlayerLab/GoLLeM-110M-PL-v2",
        "GoLLeM-110M-v3":"SlayerLab/GoLLeM-110M-PL-v3","Slayer-110M":"SlayerLab/Slayer-110M-PL",
        "Polock-125M":"SlayerLab/pollock-mini-lm-125m"}
out={"n_docs":len(docs),"doc_bytes":[len(t.encode("utf-8")) for t in docs],"models":{}}
for name,hid in models.items():
    tok=AutoTokenizer.from_pretrained(hid)
    model=AutoModelForCausalLM.from_pretrained(hid,dtype=torch.float32).eval()
    nats=[]
    for t in docs:
        ids=tok(t,return_tensors="pt").input_ids[:,:1024]
        if ids.shape[1]<2: nats.append(0.0); continue
        with torch.no_grad(): lg=model(ids).logits
        lp=torch.log_softmax(lg[:,:-1,:].float(),dim=-1)
        nats.append(lp.gather(-1,ids[:,1:].unsqueeze(-1)).squeeze(-1).sum().item())
    out["models"][name]={"vocab":tok.vocab_size,"doc_nats":nats}
    tot_nats=sum(nats); tot_b=sum(out["doc_bytes"])
    print(f"{name} BPB={-tot_nats/math.log(2)/tot_b:.4f}",flush=True)
json.dump(out,open("C:/tmp/bpb_perdoc.json","w",encoding="utf-8"))
print("saved per-doc: C:/tmp/bpb_perdoc.json")
