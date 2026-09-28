'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  type SavedBasket, loadSavedBaskets, saveBasketRemote, deleteBasketRemote, newBasketId,
} from './basketStorage';

type AddToast = (type: 'success' | 'error', message: string, detail?: string) => void;

/** Saved-basket list shared by the Baskets and Option Strats pages. Every change is optimistic
 *  locally and persisted per basket by id; the network call is made outside the state updater so
 *  StrictMode's double-invoked updaters can't send it twice. */
export function useSavedBaskets(addToast: AddToast) {
  const [saved, setSaved] = useState<SavedBasket[]>([]);

  useEffect(() => { loadSavedBaskets().then(setSaved); }, []);

  const persist = useCallback((basket: SavedBasket, what: string) => {
    saveBasketRemote(basket).catch(() =>
      addToast('error', `Failed to ${what} basket`, 'Change may not persist — check the server'));
  }, [addToast]);

  /** Saves by name: an existing basket with the same name is overwritten (keeping its id). */
  const saveByName = useCallback((entry: Omit<SavedBasket, 'id'>): boolean => {
    const existing = saved.find(s => s.name === entry.name);
    const basket: SavedBasket = { ...entry, id: existing?.id ?? newBasketId() };
    setSaved(prev => [...prev.filter(s => s.id !== basket.id), basket]);
    persist(basket, 'save');
    return Boolean(existing);
  }, [saved, persist]);

  const remove = useCallback((id: string) => {
    setSaved(prev => prev.filter(s => s.id !== id));
    deleteBasketRemote(id).catch(() =>
      addToast('error', 'Failed to delete basket', 'Change may not persist — check the server'));
  }, [addToast]);

  const rename = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    const target = saved.find(s => s.id === id);
    if (!trimmed || !target || trimmed === target.name) return;
    if (saved.some(s => s.id !== id && s.name === trimmed)) {
      addToast('error', `A basket named "${trimmed}" already exists`);
      return;
    }
    const renamed = { ...target, name: trimmed };
    setSaved(prev => prev.map(s => (s.id === id ? renamed : s)));
    persist(renamed, 'rename');
  }, [saved, persist, addToast]);

  const duplicate = useCallback((id: string) => {
    const target = saved.find(s => s.id === id);
    if (!target) return;
    let name = `${target.name} copy`;
    for (let n = 2; saved.some(s => s.name === name); n++) name = `${target.name} copy ${n}`;
    const copy: SavedBasket = { ...target, id: newBasketId(), name };
    setSaved(prev => [...prev, copy]);
    persist(copy, 'duplicate');
    addToast('success', `Duplicated as "${name}"`);
  }, [saved, persist, addToast]);

  return { saved, saveByName, remove, rename, duplicate };
}
