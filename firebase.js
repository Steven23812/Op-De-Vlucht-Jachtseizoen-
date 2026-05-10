import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, get, onValue, off } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyBHn-W2sEAsK9iTDlNgswLK9Kr3j-8-2cU",
  authDomain: "jachtseizoenscharne.firebaseapp.com",
  databaseURL: "https://jachtseizoenscharne-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "jachtseizoenscharne",
  storageBucket: "jachtseizoenscharne.firebasestorage.app",
  messagingSenderId: "812677624468",
  appId: "1:812677624468:web:02045c4871cc5b5051fa81",
  measurementId: "G-VTHQLCS3MC"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

export async function readParty(code) {
  const snap = await get(ref(db, `parties/${code}`));
  return snap.exists() ? snap.val() : null;
}

export async function writeParty(code, data) {
  await set(ref(db, `parties/${code}`), data);
}

export function subscribeParty(code, callback) {
  const r = ref(db, `parties/${code}`);
  onValue(r, snap => callback(snap.exists() ? snap.val() : null));
  return () => off(r);
}
