#![cfg(not(debug_assertions))]

use std::hint::black_box;
use std::time::Instant;

use tuvren_kernel_rust::{InMemoryKernel, KernelResult};

#[test]
fn store_read_and_write_timings() -> KernelResult<()> {
    for count in [1_000_u64, 5_000, 20_000] {
        let kernel = InMemoryKernel::new();
        let mut hash = String::new();
        for index in 0..count {
            hash = kernel.store_put(index.to_le_bytes().to_vec(), None)?;
        }
        let iterations = 200_u32;
        for _ in 0..20 {
            assert!(kernel.store_has(black_box(&hash))?);
            black_box(kernel.store_put(black_box(0_u64.to_le_bytes().to_vec()), None)?);
        }
        let read_start = Instant::now();
        for _ in 0..iterations {
            assert!(black_box(kernel.store_has(black_box(&hash))?));
        }
        let read_us = read_start.elapsed().as_secs_f64() * 1e6 / f64::from(iterations);
        let write_start = Instant::now();
        for _ in 0..iterations {
            black_box(kernel.store_put(black_box(0_u64.to_le_bytes().to_vec()), None)?);
        }
        let write_us = write_start.elapsed().as_secs_f64() * 1e6 / f64::from(iterations);
        println!(
            "{count} distinct 8-byte objects; {iterations} calls/path; store_put={write_us:.6} us/call; store_has={read_us:.6} us/call"
        );
    }
    Ok(())
}
